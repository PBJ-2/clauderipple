import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awakeRemove, awakeSetup, releaseAwake, releaseFailedHint, type SetupDeps } from "../src/awake-setup.ts";
import { formatPower } from "../src/power.ts";
import { readJournal, type RunOptions, type RunResult } from "../../router/src/awake.ts";
import { LIDACTION, SUB_BUTTONS } from "../../router/src/awake-win.ts";
import type { PowerStatus } from "../../router/src/power.ts";

const SCHEME = "381b4222-f694-41f0-9685-ff5bb260df2e";
const QUERY = `Power Scheme GUID: ${SCHEME}  (Balanced)\n    Power Setting GUID: ${LIDACTION}  (Lid close action)\n    Current AC Power Setting Index: 0x00000001\n    Current DC Power Setting Index: 0x00000002\n`;
const xml = (name: string, mode: string) => `<WLANProfile><name>${name}</name><SSIDConfig><SSID><name>${name}</name></SSID></SSIDConfig><connectionMode>${mode}</connectionMode></WLANProfile>`;

function deps(o: { writeFails?: string; profiles?: [string, "auto" | "manual"][]; adapter?: string } = {}) {
  const rippleHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-setup-win-"));
  const calls: string[] = [];
  const printed: string[] = [];
  const profiles = o.profiles ?? [["Home", "auto"], ["PBJ", "manual"]];
  const run = async (file: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    const exe = path.win32.basename(file).toLowerCase();
    calls.push(`${exe} ${exe === "powershell.exe" ? "<script>" : args.join(" ")}`);
    if (exe === "powercfg.exe") {
      if (args[0] === "/q") return { code: 0, stdout: QUERY, stderr: "" };
      if (o.writeFails && args[0]!.startsWith("/set")) return { code: 1, stdout: o.writeFails, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (exe === "powershell.exe") return { code: 0, stdout: o.adapter ?? "Wi-Fi\r\n", stderr: "" };
    if (exe === "netsh.exe" && args.join(" ") === "wlan show profiles") return { code: 0, stdout: profiles.map(([n]) => `    All User Profile     : ${n}`).join("\n"), stderr: "" };
    if (exe === "netsh.exe" && args[1] === "export") {
      assert.equal(opts?.verbatim, true);
      const dir = /folder="([^"]+)"/.exec(args.join(" "))![1]!;
      for (const [n, m] of profiles) fs.writeFileSync(path.join(dir, `Wi-Fi-${n}.xml`), xml(n, m));
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected ${exe} ${args.join(" ")}`);
  };
  const d: SetupDeps = {
    platform: "win32",
    run,
    user: "pbj", uid: 0, home: "C:\\Users\\pbj", rippleHome,
    exists: () => false,
    writeTemp: () => { throw new Error("no temp file on Windows"); },
    removeTemp: () => {},
    trashFallback: () => {},
    print: (l) => void printed.push(l),
  };
  return { d, calls, printed, rippleHome };
}

test("Windows setup: no prompt, no install — a no-op write proves the lid action can change, profiles are checked", async () => {
  const t = deps();
  const r = await awakeSetup({ ssid: "PBJ" }, t.d);
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail, /no administrator step/);
  assert.equal(r.wifiDevice, "Wi-Fi");
  assert.ok(t.calls.includes(`powercfg.exe /setacvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 1`), "AC written back as it was");
  assert.ok(t.calls.includes(`powercfg.exe /setdcvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 2`), "DC written back as it was");
  assert.ok(!t.calls.some((c) => /osascript|sudo|runas|Start-Process/i.test(c)));
  const out = t.printed.join("\n");
  assert.match(out, /plugged in Sleep, on battery Hibernate/);
  assert.match(out, /Windows has joined "PBJ" before/);
  assert.match(out, /1 other Wi-Fi network connects automatically/);
});

test("Windows setup says what is missing: no hotspot profile, nothing to come back to, the hotspot itself automatic", async () => {
  const t = deps({ profiles: [["PBJ", "auto"]] });
  assert.equal((await awakeSetup({ ssid: "PBJ" }, t.d)).ok, true);
  const out = t.printed.join("\n");
  assert.match(out, /no other Wi-Fi on this PC is set to connect automatically/);
  assert.match(out, /connectionmode=manual/);
  const u = deps({ profiles: [["Home", "auto"]] });
  await awakeSetup({ ssid: "PBJ" }, u.d);
  assert.match(u.printed.join("\n"), /has not joined this hotspot before/);
});

test("Windows setup refuses: a policy-locked plan, a bad name before any command, no Wi-Fi adapter", async () => {
  const locked = deps({ writeFails: "You don't have permission to change this setting." });
  const r = await awakeSetup({}, locked.d);
  assert.equal(r.ok, false);
  assert.match(r.detail, /Group Policy/);
  const bad = deps();
  assert.equal((await awakeSetup({ ssid: "a\"b" }, bad.d)).ok, false);
  assert.deepEqual(bad.calls, []);
  const noWifi = deps({ adapter: "" });
  assert.match((await awakeSetup({ ssid: "PBJ" }, noWifi.d)).detail, /no Wi-Fi adapter/);
});

test("Windows release (stop, uninstall, awake off, setup --remove): the journaled lid action is put back", async () => {
  const t = deps();
  const journal = path.join(t.rippleHome, "awake.json");
  assert.equal(await releaseAwake(t.d.run, t.rippleHome, "stop", "win32"), "not-held");
  fs.writeFileSync(journal, JSON.stringify({ applied: true, since: "x", reason: "on" }));
  assert.equal(await releaseAwake(t.d.run, t.rippleHome, "stop", "win32"), "not-held", "held without a lid change: nothing to put back");
  assert.equal(readJournal(journal)?.applied, false);
  assert.deepEqual(t.calls, []);
  fs.writeFileSync(journal, JSON.stringify({ applied: true, since: "x", reason: "on", lid: { scheme: SCHEME, ac: 1, dc: 2 } }));
  const r = await awakeRemove(t.d);
  assert.equal(r.ok, true);
  assert.match(r.detail, /nothing to remove on Windows; the lid-close action is back to yours/);
  assert.deepEqual(t.calls, [
    `powercfg.exe /setacvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 1`,
    `powercfg.exe /setdcvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 2`,
    "powercfg.exe /setactive SCHEME_CURRENT",
  ]);
  assert.equal(readJournal(journal)?.applied, false);
  const failing = deps({ writeFails: "denied" });
  fs.writeFileSync(path.join(failing.rippleHome, "awake.json"), JSON.stringify({ applied: true, since: "x", reason: "on", lid: { scheme: SCHEME, ac: 1, dc: 2 } }));
  assert.equal(await releaseAwake(failing.d.run, failing.rippleHome, "stop", "win32"), "failed");
  assert.equal(readJournal(path.join(failing.rippleHome, "awake.json"))?.applied, true, "still recorded, for the next try");
  assert.match(releaseFailedHint("win32"), /Choose what closing the lid does/);
  assert.match(releaseFailedHint("darwin"), /pmset/);
});

test("status text says PC on Windows", () => {
  const s: PowerStatus = {
    platform: "win32",
    awake: { mode: "on", applied: true, reason: "on", setup: "ok", battery: { percent: 70, onBattery: true }, thermal: "unknown", lidClosed: false, until: null, conflict: null },
    tether: { enabled: false, network: "wifi", state: "off", pinned: false, hotspotSsid: "", lastSwitch: null, lastProbe: null, hint: null },
  };
  const text = formatPower(s).join("\n");
  assert.match(text, /holding the PC awake/);
  assert.match(text, /battery 70% \(on battery\) · thermal unknown · lid open/);
});
