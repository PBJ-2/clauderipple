import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as launchd from "../src/launchd.ts";
import * as systemd from "../src/systemd.ts";
import * as schtasks from "../src/schtasks.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-service-race-"));
  // USERPROFILE too: on Windows os.homedir() reads it, and the task lock lives under it. On the real
  // home this file and ownership.test.ts shared one lock in parallel (Windows CI, 2026-10-29).
  const keys = ["HOME", "USERPROFILE", "CLAUDERIPPLE_LAUNCH_AGENTS_DIR", "XDG_CONFIG_HOME"] as const;
  const before = keys.map(key => [key, process.env[key]] as const);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR = path.join(root, "LaunchAgents");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  t.after(() => {
    for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, a: path.join(root, "a"), b: path.join(root, "b") };
}

for (const operation of ["install", "remove", "stop", "start", "restart"] as const) {
  test(`launchd ${operation} refuses a definition replaced during its external lookup`, t => {
    const f = fixture(t);
    const file = launchd.plistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = launchd.renderPlist({ home: f.a, program: "/node", stdoutLog: "/unused" });
    if (operation !== "install") fs.writeFileSync(file, old);
    const replacement = launchd.renderPlist({ home: f.b, program: "/other-node", stdoutLog: "/unused" });
    const controls: string[] = [];
    const run: launchd.Launchctl = args => {
      if (args[0] === "print") { fs.writeFileSync(file, replacement); return { ok: true, out: "state = waiting" }; }
      controls.push(args[0]!); return { ok: true, out: "" };
    };
    try {
      if (operation === "install") launchd.installAgent({ home: f.a, program: "/node" }, run);
      if (operation === "remove") launchd.removeAgent(f.a, run);
      if (operation === "stop") launchd.stopAgent(f.a, run);
      if (operation === "start") launchd.startAgent(f.a, run, { waitMs: 0 });
      if (operation === "restart") launchd.restartAgent(f.a, { waitMs: 0 }, run);
    } catch (error) { assert.match(String(error), /changed|변경/); }
    assert.deepEqual(controls, []);
    assert.equal(fs.readFileSync(file, "utf8"), replacement);
  });
}

for (const operation of ["install", "remove", "stop", "start", "restart"] as const) {
  test(`systemd ${operation} refuses a definition replaced during its external lookup`, t => {
    const f = fixture(t);
    const file = systemd.unitPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemd.renderUnit({ home: f.a, program: "/node" }));
    const replacement = systemd.renderUnit({ home: f.b, program: "/other-node" });
    const controls: string[] = [];
    const run: systemd.Systemctl = args => {
      if (args[0] === "show" || args[0] === "show-environment") { fs.writeFileSync(file, replacement); return { ok: true, out: args.includes("--property=MainPID") ? "0" : "inactive" }; }
      controls.push(args[0]!); return { ok: true, out: "0" };
    };
    try {
      if (operation === "install") systemd.installAgent({ home: f.a, program: "/node" }, run);
      if (operation === "remove") systemd.removeAgent(f.a, run);
      if (operation === "stop") systemd.stopAgent(f.a, {}, run);
      if (operation === "start") systemd.startAgent(f.a, { waitMs: 0 }, run);
      if (operation === "restart") systemd.restartAgent(f.a, { waitMs: 0 }, run);
    } catch (error) { assert.match(String(error), /changed|변경|another ClaudeRipple installation/); }
    assert.deepEqual(controls, []);
    assert.equal(fs.readFileSync(file, "utf8"), replacement);
  });
}

test("launchd writers share a lock across installation homes", t => {
  const f = fixture(t);
  let checked = false;
  launchd.installAgent({ home: f.a, program: "/node" }, args => {
    if (args[0] === "print" && !checked) {
      checked = true;
      assert.throws(() => launchd.installAgent({ home: f.b, program: "/other" }, () => ({ ok: false, out: "", code: 113 })), { code: "ELOCKED" });
    }
    return args[0] === "print" ? { ok: false, out: "", code: 113 } : { ok: true, out: "" };
  });
  assert.equal(checked, true);
});

test("launchd rejects a same-home generation change after identity verification", t => {
  const f = fixture(t);
  const file = launchd.plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, launchd.renderPlist({ home: f.a, program: "/old-node", stdoutLog: "/unused" }));
  const replacement = launchd.renderPlist({ home: f.a, program: "/new-node", stdoutLog: "/unused" });
  let controls = 0;
  assert.throws(() => launchd.removeAgent(f.a, args => {
    if (args[0] === "print") return { ok: true, out: "state = running\n pid = 42\n" };
    controls++; return { ok: true, out: "" };
  }, () => { fs.writeFileSync(file, replacement); return "ours"; }), /변경/);
  assert.equal(controls, 0);
  assert.equal(fs.readFileSync(file, "utf8"), replacement);
});

test("Windows install never writes a launcher over a replacement registration", t => {
  const f = fixture(t);
  let reads = 0;
  let controls = 0;
  const deps: schtasks.TaskDeps = { definition: () => ++reads === 1 ? null : { arguments: `-File "${path.join(f.b, "clauderipple-router.ps1")}"` }, run: () => { controls++; return { ok: true, out: "ok" }; } };
  assert.throws(() => schtasks.installAgent({ home: f.a, program: "/node" }, deps), /변경/);
  assert.equal(controls, 0);
  assert.equal(fs.existsSync(path.join(f.a, "clauderipple-router.ps1")), false);
});

for (const operation of ["remove", "stop", "start"] as const) {
  test(`Windows ${operation} rechecks the task generation before control`, t => {
    const f = fixture(t);
    let foreign = false;
    let reads = 0;
    const controls: string[] = [];
    const deps: schtasks.TaskDeps = {
      definition: () => ({ arguments: `-File "${path.join(foreign || (operation === "stop" && ++reads > 1) ? f.b : f.a, "clauderipple-router.ps1")}"` }),
      run: script => {
        if (script.includes(".State") || script.includes("Get-CimInstance")) { foreign = true; return { ok: true, out: "Ready" }; }
        controls.push(script); return { ok: true, out: "ok" };
      },
    };
    try {
      if (operation === "remove") schtasks.removeAgent("race-task", { home: f.a, deps });
      if (operation === "stop") schtasks.stopAgent("race-task", { home: f.a, deps });
      if (operation === "start") schtasks.startAgent("race-task", { home: f.a, deps, waitMs: 0 });
    } catch (error) { assert.match(String(error), /changed|변경/); }
    assert.deepEqual(controls, []);
  });
}
