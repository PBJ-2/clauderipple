// One per-user service definition is shared by every installation on the account: one launchd
// label, one systemd unit, one task name. Removing, stopping, restarting or re-registering it
// therefore has to prove the definition belongs to *this* home (B01, 2026-10-25); the launchd tray
// agent has the same rule. Nothing here may reach launchd, Task Scheduler, systemd, a real home or
// a real process: every definition lives in a temp directory and every executor is injected.
// process.platform is never spoofed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ownership-"));
const tripwire = path.join(root, "tripwire");
fs.writeFileSync(tripwire, `#!/bin/sh\necho "real service runner used: $*" >> "${path.join(root, "tripwire.log")}"\nexit 97\n`, { mode: 0o755 });
Object.assign(process.env, {
  CLAUDERIPPLE_HOME: path.join(root, "unused-home"),
  CLAUDERIPPLE_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"),
  CLAUDERIPPLE_LAUNCHCTL: tripwire,
  XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  // The Windows task lock sits under os.homedir(), which reads USERPROFILE there. Left on the real
  // home, this file and service-races.test.ts took the same task's lock at once in parallel, and one
  // found the other's lock before its owner file existed (Windows CI, 2026-10-29).
  HOME: root,
  USERPROFILE: root,
});
// The production labels on purpose: the defect is two installations sharing one definition. The
// temp directories above are what keep this away from the user's real services.
delete process.env.CLAUDERIPPLE_LAUNCHD_LABEL;
delete process.env.CLAUDERIPPLE_TRAY_LAUNCHD_LABEL;
delete process.env.CLAUDERIPPLE_TASK_NAME;
delete process.env.CLAUDERIPPLE_SYSTEMD_UNIT;
process.on("exit", () => {
  const tripped = fs.existsSync(path.join(root, "tripwire.log"));
  fs.rmSync(root, { recursive: true, force: true });
  if (tripped) {
    console.error("the default service runner was used by a test");
    process.exitCode = 1;
  }
});

const launchd = await import("../src/launchd.ts");
const systemd = await import("../src/systemd.ts");
const schtasks = await import("../src/schtasks.ts");
const { launcherHome, normalizeHome, plistEnvironment, unitEnvironment } = await import("../src/ownership.ts");
const { restartWindowsRouter, startRouter, stopWindowsRouter } = await import("../src/supervisor.ts");
const { adminUrl, routerIdentity } = await import("../src/router-state.ts");
const { ensureInstallationId, installationIdPath, readInstallationId } = await import("../../router/src/installation-id.ts");

const A = path.join(root, "install-a");
const B = path.join(root, "install-b");
const program = process.execPath;

function recorder() {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => (calls.push(args), { ok: true, out: args.includes("--property=MainPID") ? "0" : args[0] === "print" ? "state = waiting" : "" }) };
}

/** The Windows executor: one PowerShell script per call. */
function taskRecorder() {
  const calls: string[] = [];
  return { calls, run: (script: string) => (calls.push(script), { ok: true, out: "ok" }) };
}

/** A launchctl that keeps one job's state, so restart/start paths see a process appear. */
function launchdFake() {
  const calls: string[][] = [];
  let loaded = false;
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args);
      if (args[0] === "print") {
        return loaded ? { ok: true, out: "state = running\n\tpid = 999999\n" } : { ok: false, out: "Could not find service" };
      }
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "bootstrap" || args[0] === "kickstart") loaded = true;
      return { ok: true, out: "" };
    },
  };
}

/** Reads the definition text a platform wrote, so a test can assert it survived untouched. */
const read = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// ---- ownership parsing ---------------------------------------------------------------------

test("a definition's recorded home is read from the plist, the unit and the task arguments", () => {
  const plist = launchd.renderPlist({ program, args: ["/r.ts"], home: "/Users/me/.clauderipple", stdoutLog: "/l" });
  assert.equal(plistEnvironment(plist).CLAUDERIPPLE_HOME, "/Users/me/.clauderipple");
  const unit = systemd.renderUnit({ program, args: ["/r.ts"], home: "/tmp/a b" });
  assert.equal(unitEnvironment(unit).CLAUDERIPPLE_HOME, "/tmp/a b");
  // The Windows task's action names the launcher inside the home; that path is the ownership.
  assert.equal(launcherHome(`--headless powershell.exe -NoProfile -File "C:\\Users\\me\\a\\clauderipple-router.ps1"`), "C:\\Users\\me\\a");
  assert.equal(launcherHome(`powershell.exe -File 'C:\\Users\\me\\b c\\clauderipple-router.ps1'`), "C:\\Users\\me\\b c");
  assert.equal(launcherHome("--headless powershell.exe"), null);
  // Two spellings of the same home are one home; another home is another.
  assert.equal(normalizeHome("/tmp/x/../x"), normalizeHome("/tmp/x"));
});

// ---- launchd: the router agent -------------------------------------------------------------

test("another installation's launchd agent is never stopped, removed or replaced", () => {
  launchd.installAgent({ program, args: ["/r.ts"], home: A }, recorder().run);
  const file = launchd.plistPath();
  const before = read(file);
  assert.deepEqual(launchd.agentOwnership(A), { state: "ours", home: A });
  assert.deepEqual(launchd.agentOwnership(B), { state: "other", home: A });

  const fake = launchdFake();
  assert.equal(launchd.stopAgent(B, fake.run), "other-installation");
  assert.equal(launchd.startAgent(B, fake.run), "other-installation");
  assert.equal(launchd.restartAgent(B, undefined, fake.run), "other-installation");
  assert.equal(launchd.removeAgent(B, fake.run), "other-installation");
  assert.deepEqual(fake.calls, [], "nothing was asked of launchd");
  assert.equal(read(file), before, "the other installation's definition is byte-identical");

  assert.throws(() => launchd.installAgent({ program, args: ["/r.ts"], home: B }, fake.run), /another ClaudeRipple installation/);
  assert.equal(read(file), before);
  assert.deepEqual(fake.calls, []);
});

test("this installation's agent stops, restarts and is removed as before", () => {
  fs.rmSync(launchd.plistPath(), { force: true }); // a previous test's installation
  const fake = launchdFake();
  launchd.installAgent({ program, args: ["/r.ts"], home: B }, fake.run);
  const file = launchd.plistPath();
  const ours = (expectedPid: number | null) => {
    assert.equal(expectedPid, 999999, "the pid the caller would act on is the one verified");
    return "ours" as const;
  };
  assert.equal(launchd.stopAgent(B, fake.run, ours), "stopped");
  assert.ok(fake.calls.some((c) => c[0] === "bootout"));
  // No pid to drain (the fake job is unloaded): a hard restart, never a signal to a test's pid.
  assert.equal(launchd.restartAgent(B, { waitMs: 0 }, fake.run), "kickstarted");
  assert.equal(launchd.removeAgent(B, fake.run, ours), "removed");
  assert.equal(fs.existsSync(file), false);
  assert.equal(launchd.removeAgent(B, fake.run), "absent");
  // A definition with no home recorded is not ours to remove.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0"?><plist><dict><key>Label</key><string>${launchd.launchdLabel()}</string></dict></plist>`);
  assert.equal(launchd.stopAgent(B, fake.run), "ownership-unknown");
  assert.equal(launchd.removeAgent(B, fake.run), "ownership-unknown");
  assert.ok(fs.existsSync(file));
});

test("a launchd job that cannot be proven this installation's is not unloaded or signalled", () => {
  fs.rmSync(launchd.plistPath(), { force: true });
  const fake = launchdFake();
  launchd.installAgent({ program, args: ["/r.ts"], home: B }, fake.run);
  const before = read(launchd.plistPath());
  fake.calls.length = 0;
  const other = () => "other" as const;
  const unknown = () => "absent" as const;
  assert.equal(launchd.stopAgent(B, fake.run, other), "other-installation");
  assert.equal(launchd.stopAgent(B, fake.run, unknown), "identity-unknown");
  assert.equal(launchd.removeAgent(B, fake.run, other), "other-installation");
  assert.equal(launchd.removeAgent(B, fake.run, unknown), "identity-unknown");
  assert.equal(launchd.restartAgent(B, { waitMs: 0 }, fake.run, other), "other-installation");
  assert.equal(launchd.restartAgent(B, { waitMs: 0 }, fake.run, unknown), "identity-unknown");
  assert.ok(fake.calls.every((c) => c[0] === "print"), "only reads: no bootout, no kickstart, no signal");
  assert.equal(read(launchd.plistPath()), before);
  // install's own bootout is gated the same way: a running unproven job is never unloaded.
  fake.calls.length = 0;
  assert.throws(() => launchd.installAgent({ program: "/different/runtime", args: ["/changed.ts"], home: B }, fake.run, other), /cannot be verified/);
  assert.equal(read(launchd.plistPath()), before);
  assert.ok(!fake.calls.some((c) => c[0] === "bootout" || c[0] === "bootstrap"), fake.calls.map((c) => c[0]).join());
  fs.rmSync(launchd.plistPath(), { force: true });
});

test("launchd restart verifies the exact captured signal target even when the next lookup would differ", () => {
  fs.mkdirSync(path.dirname(launchd.plistPath()), { recursive: true });
  fs.writeFileSync(launchd.plistPath(), launchd.renderPlist({ program, home: B, stdoutLog: path.join(B, "test.log") }));
  let reads = 0;
  const run: import("../src/launchd.ts").Launchctl = args => {
    assert.equal(args[0], "print", "an unverified pid must never reach a control operation");
    return { ok: true, out: `state = running\n pid = ${++reads === 1 ? 999999 : 888888}\n` };
  };
  let checked: number | null = null;
  assert.equal(launchd.restartAgent(B, { waitMs: 0 }, run, pid => { checked = pid; return "other"; }), "other-installation");
  assert.equal(checked, 999999, "the pid captured for SIGTERM is the only pid that may authorize it");
  fs.rmSync(launchd.plistPath(), { force: true });
});

// ---- launchd: the tray agent ---------------------------------------------------------------

test("another installation's tray agent is kept, and its own is removed", () => {
  launchd.installTrayAgent(A);
  const file = launchd.trayPlistPath();
  assert.equal(launchd.removeTrayAgent(B), "other-installation");
  assert.ok(fs.existsSync(file));
  assert.throws(() => launchd.installTrayAgent(B), /another ClaudeRipple installation/);
  assert.equal(launchd.removeTrayAgent(A), "removed");
  assert.equal(fs.existsSync(file), false);
  assert.equal(launchd.removeTrayAgent(A), "absent");
});

// ---- systemd -------------------------------------------------------------------------------

test("another installation's systemd unit is preserved; this one's is removed", () => {
  const fake = recorder();
  const file = systemd.installAgent({ program, args: ["/r.ts"], home: A }, fake.run);
  assert.deepEqual(systemd.unitOwnership(B), { state: "other", home: A });
  const before = read(file);

  const other = recorder();
  assert.equal(systemd.stopAgent(B, {}, other.run), "other-installation");
  assert.equal(systemd.startAgent(B, {}, other.run), "other-installation");
  assert.equal(systemd.restartAgent(B, {}, other.run), "other-installation");
  assert.equal(systemd.removeAgent(B, other.run), "other-installation");
  assert.deepEqual(other.calls, []);
  assert.equal(read(file), before);
  assert.throws(() => systemd.installAgent({ program, args: ["/r.ts"], home: B }, other.run), /another ClaudeRipple installation/);

  const mine = recorder();
  assert.equal(systemd.stopAgent(A, {}, mine.run), "stopped");
  assert.equal(systemd.removeAgent(A, mine.run), "removed");
  // The MainPID probes are reads; only these three calls change anything.
  assert.deepEqual(mine.calls.map((c) => c.join(" ")).filter((v) => !v.startsWith("show ")), ["stop clauderipple.service", "disable --now clauderipple.service", "daemon-reload"]);
  assert.equal(read(file), null);
});

// ---- Windows scheduled task ----------------------------------------------------------------

const winA = "C:\\Users\\me\\a";
const winB = "C:\\Users\\me\\b";

/** The task definition Windows reports for an installation's launcher. */
function taskOf(home: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionCount: 1,
    execute: "conhost.exe",
    arguments: `--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.win32.join(home, "clauderipple-router.ps1")}"`,
    userId: "ME",
    runLevel: 0,
    logonType: 3,
    triggerCount: 1,
    triggerType: "MSFT_TaskLogonTrigger",
    triggerUserId: "ME",
    restartCount: 99,
    restartInterval: "PT1M",
    executionTimeLimit: "PT0S",
    multipleInstances: 2,
    allowStartIfOnBatteries: true,
    dontStopIfGoingOnBatteries: true,
    ...extra,
  };
}

test("another installation's task is never stopped, removed or restarted, and its pid is never read", () => {
  const definition = () => taskOf(winA);
  assert.deepEqual(schtasks.taskOwnership(winB, { definition }), { state: "other", home: winA });
  const fake = taskRecorder();
  const deps = { definition, run: fake.run };

  assert.equal(schtasks.stopAgent(undefined, { home: winB, deps }), "other-installation");
  assert.equal(schtasks.startAgent(undefined, { home: winB, deps }), "other-installation");
  assert.equal(schtasks.removeAgent(undefined, { home: winB, deps }), "other-installation");
  assert.equal(schtasks.agentPid(undefined, { home: winB, expectedRouter: "C:\\b\\router.js", deps }), null);
  assert.deepEqual(fake.calls, [], "no PowerShell ran, so no other installation's pid was seen");
  assert.throws(() => schtasks.installAgent({ program, args: ["C:\\b\\router.js"], home: winB }, deps), /another ClaudeRipple installation/);
  assert.deepEqual(fake.calls, []);
});

test("this installation's task stops, removes and reports only its own router pid", () => {
  const definition = () => taskOf(winB);
  const calls: string[] = [];
  const run = (script: string) => {
    calls.push(script);
    if (script.includes("Get-CimInstance")) return { ok: true, out: JSON.stringify({ pid: 5150, commandLine: '"C:\\node.exe" "C:\\b\\router.js"' }) };
    return { ok: true, out: "ok" };
  };
  const deps = { definition, run };

  assert.equal(schtasks.agentPid(undefined, { home: winB, expectedRouter: "C:\\b\\router.js", deps }), 5150);
  assert.equal(schtasks.agentPid(undefined, { home: winB, expectedRouter: "C:\\a\\router.js", deps }), null, "a process running another installation's script is not ours");
  assert.equal(schtasks.stopAgent(undefined, { home: winB, deps }), "stopped");
  assert.ok(calls.some((s) => s.includes("Stop-ScheduledTask")));
  assert.equal(schtasks.removeAgent(undefined, { home: winB, deps }), "removed");
  assert.ok(calls.some((s) => s.includes("Unregister-ScheduledTask")));
});

test("#110: no router process yet is no pid, not a crash", () => {
  const run = (script: string) => (script.includes("Get-CimInstance") ? { ok: true, out: "null\r\n" } : { ok: true, out: "ok" });
  assert.equal(schtasks.agentPid(undefined, { home: winB, expectedRouter: "C:\\b\\router.js", deps: { definition: () => taskOf(winB), run } }), null);
});

test("a task definition with no installation in it is not replaced", () => {
  const deps = { definition: () => taskOf(winA, { arguments: "--headless powershell.exe -NoProfile" }), run: taskRecorder().run };
  assert.deepEqual(schtasks.taskOwnership(winB, deps), { state: "unknown", home: null });
  assert.equal(schtasks.stopAgent(undefined, { home: winB, deps }), "ownership-unknown");
  assert.equal(schtasks.removeAgent(undefined, { home: winB, deps }), "ownership-unknown");
  assert.throws(() => schtasks.installAgent({ program, args: [], home: winB }, deps), /cannot be identified/);
});

// ---- supervisor: a gated start is not retried as an unsupervised one -----------------------

test("a start refused by ownership is a result, not a reason to start a second router", () => {
  for (const refused of ["other-installation", "ownership-unknown"] as const) {
    let started = 0;
    const out = startRouter({
      start: () => refused,
      up: () => false,
      fallback: () => ((started++), 4242),
      alive: () => true,
      healthy: () => true,
      now: () => 0,
      sleep: () => {},
    });
    assert.equal(out, refused);
    assert.equal(started, 0);
  }
});

// ---- Windows: identity is this installation's admin port, never a pid ---------------------

test("Windows stop and restart act only on the instance under this task's own launcher", () => {
  const ownerOf = (state: "ours" | "other" | "unknown" | "absent") => ({ state, home: state === "other" ? winA : null });
  const fake = (o: {
    owner?: () => ReturnType<typeof ownerOf>;
    pid?: number | null;
    identities?: Array<"ours" | "other" | "absent">;
    running?: boolean;
    drained?: boolean;
    shutdown?: () => boolean;
  }) => {
    const calls: string[] = [];
    let i = 0;
    let running = o.running ?? true;
    const identities = o.identities ?? ["ours"];
    return {
      calls,
      ops: {
        owner: o.owner ?? (() => ownerOf("ours")),
        targetPid: () => o.drained && !running ? null : (o.pid === undefined ? 5150 : o.pid),
        identity: (expectedPid: number | null) => {
          assert.equal(expectedPid, o.pid === undefined ? 5150 : o.pid, "the caller must check the pid it would act on");
          return identities[Math.min(i++, identities.length - 1)]!;
        },
        running: () => running,
        shutdown: () => { calls.push("shutdown"); if (o.drained) running = false; return o.shutdown ? o.shutdown() : true; },
        stopTask: () => (calls.push("stopTask"), (running = false), "stopped" as const),
        start: () => (calls.push("start"), "started" as const),
        now: () => Date.now(),
        sleep: () => {},
      },
    };
  };

  for (const refused of ["other", "unknown"] as const) {
    const f = fake({ owner: () => ownerOf(refused) });
    assert.equal(stopWindowsRouter(f.ops), refused === "other" ? "other-installation" : "ownership-unknown");
    assert.equal(restartWindowsRouter(f.ops), refused === "other" ? "other-installation" : "ownership-unknown");
    assert.deepEqual(f.calls, [], "nothing was asked of Task Scheduler or a router");
  }

  // Another responder on our port (another home, another server, or a same-home direct router with
  // a different pid): never told to shut down, and the task is not stopped either.
  for (const [who, expected] of [["other", "other-installation"], ["absent", "identity-unknown"]] as const) {
    const f = fake({ identities: [who] });
    assert.equal(stopWindowsRouter(f.ops), expected);
    assert.deepEqual(f.calls, [], "an unproven instance is never force-stopped");
  }
  const foreignRestart = fake({ identities: ["other"] });
  assert.equal(restartWindowsRouter(foreignRestart.ops), "other-installation");
  assert.deepEqual(foreignRestart.calls, []);

  // Nothing answers and the task has no instance: nothing to stop, nothing proven to start.
  const idle = fake({ identities: ["absent"], running: false });
  assert.equal(stopWindowsRouter(idle.ops), "not-loaded");
  assert.deepEqual(idle.calls, []);

  // Shutdown refused: the task is left alone (a forced stop would hide the failure).
  const refused = fake({ shutdown: () => false });
  assert.equal(stopWindowsRouter(refused.ops), "failed");
  assert.deepEqual(refused.calls, ["shutdown"]);
  const refusedRestart = fake({ shutdown: () => false });
  assert.equal(restartWindowsRouter(refusedRestart.ops), "failed");
  assert.deepEqual(refusedRestart.calls, ["shutdown"]);

  // Drain never completes: a failed stop, never a forced one.
  const notDraining = fake({ identities: ["ours"] });
  assert.equal(stopWindowsRouter(notDraining.ops, 0), "failed");
  assert.deepEqual(notDraining.calls, ["shutdown"]);
  assert.equal(restartWindowsRouter(fake({ identities: ["ours"] }).ops, { waitMs: 0 }), "failed");

  // Ours, drains, then the task was replaced by another home's registration: not stopped.
  let ownerCalls = 0;
  const swapped = fake({
    owner: () => (++ownerCalls === 1 ? ownerOf("ours") : ownerOf("other")),
    identities: ["ours", "absent"],
  });
  assert.equal(stopWindowsRouter(swapped.ops), "other-installation");
  assert.deepEqual(swapped.calls, ["shutdown"], "a registration replaced while waiting is re-read");

  // Ours and proven, drained: the clean launcher exits; never force-stop a replacement task.
  const draining = fake({ identities: ["ours", "absent"], drained: true });
  assert.equal(stopWindowsRouter(draining.ops), "stopped");
  assert.deepEqual(draining.calls, ["shutdown"]);

  const restarting = fake({ identities: ["absent"], running: false });
  assert.equal(restartWindowsRouter(restarting.ops), "drained");
  assert.deepEqual(restarting.calls, ["start"]);
});

test("a Windows restart waits for its replacement to answer before judging it", () => {
  // The same race launchd hit on 2026-10-26: the launcher's new process needs a moment before its
  // admin port answers, and a single probe there read "absent".
  const TARGET = 5150;
  let clock = 0;
  const scenario = (answers: Array<"ours" | "other" | "absent">, successors: number[]) => {
    const pending = [...answers];
    const queued = [...successors];
    const asked: Array<number | null> = [];
    let drained = false;
    const ops: import("../src/supervisor.ts").WindowsRouterOps = {
      owner: () => ({ state: "ours", home: winB }),
      targetPid: () => (drained ? (queued.length > 1 ? queued.shift()! : queued[0]!) : TARGET),
      identity: (expectedPid) => {
        asked.push(expectedPid);
        if (expectedPid === TARGET) return drained ? "absent" : "ours";
        return pending.length > 1 ? pending.shift()! : pending[0]!;
      },
      running: () => true,
      shutdown: () => ((drained = true), true),
      stopTask: () => "stopped",
      start: () => "started",
      now: () => clock,
      sleep: (ms) => { clock += ms; },
    };
    return { result: restartWindowsRouter(ops), asked };
  };

  assert.equal(scenario(["absent", "absent", "ours"], [6161]).result, "drained");
  assert.equal(scenario(["absent"], [6161]).result, "identity-unknown");
  assert.equal(scenario(["other", "ours"], [6161]).result, "other-installation");
  // The supervisor started it again while we waited: the pid running then is the pid judged.
  const restarted = scenario(["absent", "ours"], [6161, 6262]);
  assert.equal(restarted.result, "drained");
  assert.ok(restarted.asked.includes(6262));
});

test("a Windows pid is ambiguous when two homes share one runtime, so control never uses it", () => {
  const shared = "C:\\shared\\router\\src\\index.js";
  const definition = () => taskOf(winB);
  const run = (script: string) =>
    script.includes("Get-CimInstance")
      ? { ok: true, out: JSON.stringify({ pid: 5150, commandLine: `"C:\\node.exe" "${shared}"` }) }
      : { ok: true, out: "ok" };
  // The same command line can belong to either home: the flat pid list proves nothing.
  assert.equal(schtasks.agentPid(undefined, { home: winB, expectedRouter: shared, deps: { definition, run } }), 5150);
  // Control uses the pid under this task's own launcher, injected here; a null target authorizes
  // nothing even if some router answers the port.
  const calls: string[] = [];
  assert.equal(stopWindowsRouter({
    owner: () => ({ state: "ours", home: winB }),
    targetPid: () => null,
    identity: () => "other",
    running: () => true,
    shutdown: () => (calls.push("shutdown"), true),
    stopTask: () => (calls.push("stopTask"), "stopped"),
    start: () => (calls.push("start"), "started"),
    now: () => 0,
    sleep: () => {},
  }), "other-installation");
  assert.deepEqual(calls, []);
});

test("a response on a shared admin port needs both this installation's id and the pid we act on", () => {
  // Two homes configured for the SAME admin port: without the id, B would read A's answer as its own.
  const port = 18999;
  for (const home of [A, B]) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 18000 }, admin: { port } }));
  }
  const idA = ensureInstallationId(A);
  const idB = ensureInstallationId(B);
  assert.notEqual(idA, idB);
  assert.equal(adminUrl(A), adminUrl(B), "the same admin port is the hazard this test models");

  const status = (id: string, pid: number) => ({ version: "9.9.9", installId: id, pid });
  assert.equal(routerIdentity(A, { probe: () => status(idA, 111), expectedPid: 111 }), "ours");
  assert.equal(routerIdentity(B, { probe: () => status(idA, 111), expectedPid: 111 }), "other", "B must not accept A's router");
  assert.equal(routerIdentity(B, { probe: () => status(idB, 222), expectedPid: 222 }), "ours");
  // The same home's direct router (right id, other pid) does not authorize touching the job.
  assert.equal(routerIdentity(B, { probe: () => status(idB, 999), expectedPid: 222 }), "other");
  // A caller with no process to act on can never accept a responder.
  assert.equal(routerIdentity(B, { probe: () => status(idB, 222), expectedPid: null }), "other");
  // Any other HTTP server that answers with a version string alone is never ours.
  assert.equal(routerIdentity(B, { probe: () => ({ version: "9.9.9" }), expectedPid: 222 }), "other");
  assert.equal(routerIdentity(B, { probe: () => status("0".repeat(32), 222), expectedPid: 222 }), "other");
  assert.equal(routerIdentity(B, { probe: () => null, expectedPid: 222 }), "absent");
  // Without an id of our own, nothing can be proven either.
  const bare = path.join(root, "install-bare");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 18000 }, admin: { port } }));
  fs.rmSync(installationIdPath(bare), { force: true });
  assert.equal(routerIdentity(bare, { probe: () => ({ version: "9.9.9", pid: 222 }), expectedPid: 222 }), "other");
  assert.equal(typeof readInstallationId(bare), "string", "an upgrade gets an id without re-running install");
});

test("a task definition that cannot be read is unknown, never absent", () => {
  const failing = { run: () => ({ ok: false, out: "Access is denied" }) };
  assert.deepEqual(schtasks.readTaskDefinition(undefined, failing), { state: "error", error: "Access is denied" });
  assert.deepEqual(schtasks.taskOwnership(winB, failing), { state: "unknown", home: null });
  assert.equal(schtasks.taskRouterPid(undefined, { home: winB, deps: failing }), null);
  assert.throws(() => schtasks.installAgent({ program, args: [], home: winB }, failing), /lookup failed/);
  // Truly missing stays absent: the task scheduler said so.
  const missing = { run: () => ({ ok: true, out: "null" }) };
  assert.deepEqual(schtasks.readTaskDefinition(undefined, missing), { state: "absent" });
  assert.deepEqual(schtasks.taskOwnership(winB, missing), { state: "absent", home: null });
});

test("the router pid under this task's launcher is the one control acts on", () => {
  const oursDefinition = () => taskOf(winB);
  assert.equal(schtasks.taskRouterPid(undefined, { home: winB, deps: { definition: oursDefinition, routerPid: () => 6001 } }), 6001);
  assert.equal(
    schtasks.taskRouterPid(undefined, { home: winA, deps: { definition: oursDefinition, routerPid: () => 6001 } }),
    null,
    "another installation's task never yields a control target",
  );
});

test("unregistering a running task needs its own id and the pid under its launcher", () => {
  const definition = () => taskOf(winB);
  const calls: string[] = [];
  const run = (script: string) => {
    calls.push(script);
    if (script.includes("Get-ScheduledTask") && script.includes("State")) return { ok: true, out: "Running" };
    return { ok: true, out: "ok" };
  };
  const deps = { definition, routerPid: () => 6001, run };
  const seen: Array<number | null> = [];
  const identity = (pid: number | null) => {
    seen.push(pid);
    return "other" as const;
  };
  assert.equal(schtasks.removeAgent(undefined, { home: winB, deps, identity }), "other-installation");
  assert.deepEqual(seen, [6001], "the pid under this task's launcher is the one verified");
  assert.ok(!calls.some((s) => s.includes("Unregister")), "a foreign instance is never terminated by unregistering");
  assert.equal(schtasks.removeAgent(undefined, { home: winB, deps, identity: (pid) => (pid === 6001 ? "ours" : "other") }), "removed");
  assert.ok(calls.some((s) => s.includes("Unregister")));
});

test("a Windows start judges the router by its process and does not start one that is up", () => {
  const definition = () => taskOf(winA);
  let up = false;
  const calls: string[] = [];
  const run = (script: string) => {
    calls.push(script);
    if (script.includes("Start-ScheduledTask")) up = true;
    return { ok: true, out: "ok" };
  };
  const deps = { definition, run };
  // The task is ours; the injected process check stands in for the router's own process.
  assert.equal(schtasks.startAgent(undefined, { home: winA, deps, up: () => up, waitMs: 0 }), "started");
  assert.equal(calls.filter((s) => s.includes("Start-ScheduledTask")).length, 1);
  calls.length = 0;
  assert.equal(schtasks.startAgent(undefined, { home: winA, deps, up: () => up, waitMs: 0 }), "already-running");
  assert.deepEqual(calls, [], "a router that is already up is not started again");
});

// 0.12.14 and earlier: `/api/status` has a `home` but no `installId` and no `pid`. The upgrade path
// must accept that router (install/restart/update/uninstall all gate on identity) without opening a
// hole for any other HTTP server or another installation on the same admin port (B01/D6).
test("a router from before the installation id is ours only with this home and the listening pid", () => {
  const home = path.join(root, "legacy-install");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 18000 }, admin: { port: 18500 } }));
  fs.rmSync(installationIdPath(home), { force: true });
  // The shape 0.12.14 answered: version, home, listen — no identity keys at all.
  const legacy = { version: "0.12.14", home, listen: { host: "127.0.0.1", port: 18000 } };
  const asked: number[] = [];
  const listener = (port: number) => (asked.push(port), [4242]);
  assert.equal(routerIdentity(home, { probe: () => legacy, expectedPid: 4242, listenPids: listener }), "ours");
  assert.deepEqual(asked, [18500], "the admin port is asked, not the proxy port");
  // The pid we would act on is not the one listening: a same-home direct router, or a stranger.
  assert.equal(routerIdentity(home, { probe: () => legacy, expectedPid: 9999, listenPids: listener }), "other");
  // A caller with no process to act on can never accept a legacy responder.
  assert.equal(routerIdentity(home, { probe: () => legacy, expectedPid: null, listenPids: listener }), "other");
  // Another home's answer on the same port.
  assert.equal(routerIdentity(B, { probe: () => legacy, expectedPid: 4242, listenPids: listener }), "other");
  // The listener cannot be read: that is not proof of absence, and not proof of ownership either.
  assert.equal(routerIdentity(home, { probe: () => legacy, expectedPid: 4242, listenPids: () => null }), "other");
  // A current-version router without an identity reports `null`, which is not the legacy shape.
  assert.equal(routerIdentity(home, { probe: () => ({ ...legacy, installId: null }), expectedPid: 4242, listenPids: listener }), "other");
  // Probing still leaves the id for the router of the new version to report next time.
  assert.equal(typeof readInstallationId(home), "string");
});
