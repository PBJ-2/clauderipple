import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { listProcesses, ProcessSnapshot } from "../src/processes.ts";
import { processHasSession, liveDesktopProcesses } from "../src/desktop.ts";
import { findClaude, specFor } from "../src/service.ts";
import { renderService, TASK, UNIT, controlShutdown, refreshPlan } from "../src/host-service.ts";
import { keepAwakeCommand, PowerHold, nodeSpawner } from "../src/power.ts";
import { MAC_CONSENT_DENIED, MAC_CONSENT_PENDING, macConsent, macProtected, noisyFolder } from "../src/folders.ts";
import { batchCommand, launcherOptions } from "../src/sdk-launcher.ts";
import { HostServer } from "../src/server.ts";
import { LocalControl, localSecret } from "../src/local-control.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { renderTaskRegistration, taskUser } from "../../cli/src/schtasks.ts";

const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
test("Windows snapshot handles Unicode, null command lines and creation time without ps", () => {
  const processes = listProcesses("win32", (file, args) => {
    assert.equal(file, "powershell.exe");
    assert.ok(args.join(" ").includes("Get-CimInstance Win32_Process"));
    return JSON.stringify([{ ProcessId: 42, CommandLine: `\"C:\\한 글\\claude.exe\" --resume \"${id}\"`, CreationDate: "2026-10-17T00:00:00Z" }, { ProcessId: 4, CommandLine: null }]);
  });
  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.started, "2026-10-17T00:00:00Z");
  assert.equal(processHasSession(processes.map(p => p.command).join("\n"), id), true);
  assert.deepEqual(listProcesses("win32", () => "[]"), []);
  assert.throws(() => listProcesses("win32", () => "not JSON"));
  assert.throws(() => listProcesses("win32", () => { throw new Error("CIM unavailable"); }), /CIM unavailable/);
});
for (const platform of ["darwin", "linux"] as const) test(`${platform} snapshot reads pid and command, not header or malformed rows`, () => {
  assert.deepEqual(listProcesses(platform, (file, args) => {
    assert.equal(file, "ps"); assert.deepEqual(args, ["-axo", "pid,command"]);
    return ` PID COMMAND\n 42 claude --resume=${id}\n garbage\n`;
  }), [{ pid: 42, command: `claude --resume=${id}` }]);
});
test("macOS snapshot runs a blocking ps once, then refreshes in the background", async () => {
  let now = 0, sync = 0, async = 0;
  const snapshot = new ProcessSnapshot({
    platform: "darwin", ttlMs: 5000, now: () => now,
    exec: () => { sync++; return ` PID COMMAND\n 42 claude --resume=${id}\n`; },
    execAsync: async () => { async++; return ` PID COMMAND\n 43 claude\n`; },
  });
  // Sessions.list asks once per closed Claude app session: dozens of reads inside one list.
  for (let i = 0; i < 50; i++) assert.equal(snapshot.current()[0]?.pid, 42);
  assert.deepEqual([sync, async], [1, 0]);
  now = 5000;
  assert.equal(snapshot.current()[0]?.pid, 42, "a stale snapshot is served while the new one is read");
  snapshot.current();
  await delay(0);
  assert.deepEqual([sync, async], [1, 1]);
  assert.equal(snapshot.current()[0]?.pid, 43);
});
test("desktop registry liveness is off on Linux and reads the Windows registry", async t => {
  assert.equal(liveDesktopProcesses("/not/a/registry", 0, "linux").size, 0);
  // Windows reads the registry now: the process snapshot behind it decides who is live.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-win-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "42.json"), JSON.stringify({ sessionId: id, pid: 42, entrypoint: "claude-desktop", status: "idle", procStart: "134370764816580794" }));
  const snapshot = new ProcessSnapshot({ platform: "win32", execAsync: async () => JSON.stringify([{ ProcessId: 42, CommandLine: "claude.exe", CreationDate: "2026-10-21T17:14:41.6580790Z" }]) });
  await snapshot.prime();
  assert.equal(liveDesktopProcesses(dir, 0, "win32", snapshot).get(id)?.pid, 42);
});
test("findClaude discovers each Windows name on PATH and honors an explicit binary", () => {
  for (const name of ["claude.exe", "claude.cmd", "claude.bat"]) {
    const expected = `C:\\Tools With Spaces\\${name}`;
    assert.equal(findClaude(undefined, p => p === expected, { platform: "win32", home: "C:\\User", pathValue: "C:\\empty;C:\\Tools With Spaces" }), expected);
  }
  assert.equal(findClaude("C:\\custom.cmd", () => false), "C:\\custom.cmd");
  assert.equal(findClaude(undefined, () => false, { platform: "win32", pathValue: "" }), undefined);
  assert.deepEqual(launcherOptions("C:\\claude.exe", "win32"), {});
  assert.ok(launcherOptions("C:\\claude.cmd", "win32").spawnClaudeCodeProcess);
  assert.equal(batchCommand("C:\\With Space\\claude.cmd", ["--resume", id]), `"C:\\With Space\\claude.cmd" "--resume" "${id}"`);
  assert.throws(() => batchCommand("claude.cmd", ["x & calc"]), /unsafe/);
});
test("service rendering keeps host identity separate and preserves the saved config", () => {
  const spec = specFor({ script: "/opt/Ripple Host/dist/remote/src/main.js", node: "/opt/node/bin/node", home: "/home/me", claudePath: undefined });
  const mac = renderService(spec, "darwin");
  assert.match(mac, /com\.clauderipple\.host/);
  assert.match(mac, /KeepAlive/);
  const linux = renderService(spec, "linux");
  assert.match(linux, /Description=Ripple Remote host/);
  assert.match(linux, /Restart=always/); assert.match(linux, /UMask=0077/);
  assert.match(linux, /"\/opt\/Ripple Host\/dist\/remote\/src\/main.js"/);
  assert.equal(UNIT, "clauderipple-host.service");
  assert.equal(TASK, "ClaudeRippleHost");
  const win = renderService({ ...spec, node: "C:\\Node\\node.exe", script: "C:\\Ripple Host\\main.js" }, "win32");
  assert.match(win, /Start-Process/); assert.match(win, /while \(\$true\)/);
  assert.match(win, /'"C:\\Ripple Host\\main.js"'/);
  assert.match(win, /ExitCode -eq 0/);
  assert.ok(!win.includes("--bind"));
});
test("host logon task is headless, limited and qualified to this user, never the router task", () => {
  const user = taskUser("me", "MACHINE");
  const script = renderTaskRegistration(TASK, user, "conhost.exe", '--headless powershell.exe -NoProfile -File "C:\\host.ps1"');
  assert.match(script, /-Execute 'conhost.exe'/);
  assert.match(script, /--headless powershell.exe/);
  assert.match(script, /-AtLogOn -User 'MACHINE\\me'/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-TaskName 'ClaudeRippleHost'/);
  assert.ok(!script.includes("ClaudeRippleRouter"));
});
test("awake commands hold only system idle sleep and bind their lifetime to the host", () => {
  assert.deepEqual(keepAwakeCommand("darwin", 42), { cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "42"] });
  const win = keepAwakeCommand("win32", 42);
  assert.equal(win.cmd, "powershell.exe");
  assert.match(win.args.join(" "), /SetThreadExecutionState/);
  assert.match(win.args.join(" "), /2147483649/);
  assert.match(win.args.join(" "), /Get-Process -Id 42/);
  const linux = keepAwakeCommand("linux", 42);
  assert.equal(linux.cmd, "systemd-inhibit");
  assert.ok(linux.args.includes("--what=idle") && linux.args.includes("--mode=block"));
  assert.match(linux.args.at(-1)!, /process.kill\(42,0\)/);
});
test("missing keep-awake binary never crashes and release cancels retry", async () => {
  const hold = new PowerHold({ platform: "darwin", retryMs: 10, spawner: (_cmd, args) => nodeSpawner("ripple-test-nonexistent-command", args) });
  hold.update(true);
  await delay(30);
  hold.release();
  assert.equal(hold.holding, false);
});
test("recent folders exclude Windows temp, worktrees and node_modules with either separator", () => {
  assert.equal(noisyFolder("C:\\Users\\me\\AppData\\Local\\Temp\\run", "C:\\Users\\me\\AppData\\Local\\Temp"), true);
  assert.equal(noisyFolder("C:\\repo\\.claude\\worktrees\\worker", "C:\\Temp"), true);
  assert.equal(noisyFolder("C:\\repo\\node_modules\\pkg", "C:\\Temp"), true);
  assert.equal(noisyFolder("C:\\repo\\project", "C:\\Temp"), false);
});

const router = { status: async () => ({ ok: true, proxyEnv: {} }), models: async () => [], figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: 0 }) };
function temp(t: import("node:test").TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-platform-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("onSessions timer logs listing failure, stays reachable and retries the next change", async t => {
  const dir = temp(t);
  let fail = true;
  const diagnostics: string[] = [];
  const sessions = new Sessions({ dir, router, permissions: PermissionQueue.open(path.join(dir, "permissions.json")), queryFn: () => { throw new Error("unused"); }, desktopProjects: dir,
    desktopProcesses: () => { if (fail) throw new Error("process listing unavailable"); return ""; }, onEvent: () => {}, onSessions: () => {} });
  const project = path.join(dir, "project"); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, `${id}.jsonl`), JSON.stringify({ type: "user", cwd: project, message: { content: "test" } }) + "\n");
  const host = new HostServer({ listen: "127.0.0.1", port: 0, token: "test", webDir: dir, sessions, router, hostName: "test", version: "test", recentCli: async () => [], log: line => diagnostics.push(line) });
  t.after(async () => { await host.close(); sessions.shutdown(); });
  await host.listen(); host.onSessions();
  await delay(200);
  assert.ok(diagnostics.some(line => line.includes("session list failed: process listing unavailable")));
  assert.equal((await fetch(`http://127.0.0.1:${host.address().port}/healthz`)).status, 200);
  fail = false; host.onSessions(); await delay(200);
  assert.equal(sessions.list().length, 1);
});
test("shutdown requires the existing loopback secret, answers before callback, and drain confirms port closure", async t => {
  const dir = temp(t);
  const cfg = loadConfig(dir);
  let stops = 0;
  let server: http.Server;
  const local = new LocalControl({ dir, config: cfg, version: "test", hostPublicKey: "public", phones: () => [], rotate: () => {}, shutdown: () => { stops++; server.close(); } });
  server = http.createServer((req, res) => { void local.handle(req, res); });
  t.after(() => server.close());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  cfg.port = address.port; saveConfig(cfg, dir);
  const url = `http://127.0.0.1:${cfg.port}/local/shutdown`;
  assert.equal((await fetch(url, { method: "POST" })).status, 403);
  assert.equal(stops, 0);
  assert.equal((await fetch(url, { headers: { "x-ripple-local": localSecret(dir) } })).status, 404);
  await controlShutdown(dir);
  assert.equal(stops, 1);
});

test("an update restarts only the phone host this installation registered, and not mid-turn", () => {
  const script = "/opt/cr/lib/node_modules/clauderipple/dist/remote/src/main.js";
  const ours = `<string>${script}</string>`;
  assert.equal(refreshPlan({ installed: false, definition: null, script, busy: undefined }), "absent");
  assert.equal(refreshPlan({ installed: true, definition: null, script, busy: false }), "absent");
  // A host run from a source checkout belongs to whoever set it up that way.
  assert.equal(refreshPlan({ installed: true, definition: "<string>/Users/me/src/clauderipple/packages/remote/src/main.ts</string>", script, busy: false }), "foreign");
  assert.equal(refreshPlan({ installed: true, definition: ours, script, busy: true }), "busy");
  assert.equal(refreshPlan({ installed: true, definition: ours, script, busy: false }), "restart");
  // A host from before the busy field, or one not answering, must stay pending.
  assert.equal(refreshPlan({ installed: true, definition: ours, script, busy: undefined }), "busy");
  // The plist escapes XML; the Windows launcher doubles single quotes.
  const odd = "/Users/a&b/cr's/main.js";
  assert.equal(refreshPlan({ installed: true, definition: "<string>/Users/a&amp;b/cr's/main.js</string>", script: odd, busy: false }), "restart");
  assert.equal(refreshPlan({ installed: true, definition: "'\"/Users/a&b/cr''s/main.js\"'", script: odd, busy: false }), "restart");
});

test("a read of a folder macOS guards reports the Mac's access dialog instead of hanging", async () => {
  const home = "/Users/me";
  for (const p of ["/Users/me/Documents", "/Users/me/Desktop/app", "/Users/me/Downloads/x", "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/a", "/Volumes/USB/work"]) assert.equal(macProtected(p, home), true, p);
  for (const p of ["/Users/me", "/Users/me/code/app", "/Users/me/DocumentsOld", "/opt/work"]) assert.equal(macProtected(p, home), false, p);
  const never = (): Promise<string> => new Promise(() => {});
  await assert.rejects(macConsent("/Users/me/Documents/new", never, { platform: "darwin", home, wait: 20 }), { message: MAC_CONSENT_PENDING });
  const refused = (): Promise<string> => Promise.reject(Object.assign(new Error("operation not permitted"), { code: "EPERM" }));
  await assert.rejects(macConsent("/Users/me/Documents/new", refused, { platform: "darwin", home, wait: 20 }), { message: MAC_CONSENT_DENIED });
  assert.equal(await macConsent("/Users/me/Documents/new", async () => "listed", { platform: "darwin", home, wait: 20 }), "listed");
  // Elsewhere, and on other systems, the read is left to answer or fail on its own.
  await assert.rejects(macConsent("/Users/me/code", refused, { platform: "darwin", home, wait: 20 }), { code: "EPERM" });
  await assert.rejects(macConsent("/Users/me/Documents/new", refused, { platform: "win32", home, wait: 20 }), { code: "EPERM" });
});
