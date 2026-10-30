import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPower, parseUntil, powerCli, type PowerCall, type PowerCliDeps } from "../src/power.ts";
import type { PowerChange, PowerStatus } from "../../router/src/power.ts";
import type { RunResult } from "../../router/src/awake.ts";
import type { SetupDeps } from "../src/awake-setup.ts";

const STATUS: PowerStatus = {
  platform: "darwin",
  awake: { mode: "working", applied: true, reason: "working: 1 model call running", setup: "ok", battery: { percent: 55, onBattery: false }, thermal: "normal", lidClosed: true, until: null, conflict: null },
  tether: { enabled: true, network: "hotspot", state: "hotspot-not-visible", pinned: false, hotspotSsid: "PBJ", lastSwitch: null, lastProbe: { at: "2026-10-20T03:00:00.000Z", ok: false, network: "wifi" }, hint: "Open Personal Hotspot" },
};

test("--until HH:MM is the next time the clock shows it", () => {
  const now = new Date(2026, 9, 20, 17, 0); // local time
  assert.equal(parseUntil("18:30", now), new Date(2026, 9, 20, 18, 30).toISOString());
  assert.equal(parseUntil("09:00", now), new Date(2026, 9, 21, 9, 0).toISOString(), "earlier today means tomorrow");
  assert.equal(parseUntil("2026-10-21T08:00:00Z", now), "2026-10-21T08:00:00.000Z");
  for (const bad of ["25:00", "7pm", "18:5", ""]) assert.throws(() => parseUntil(bad, now), bad);
});

test("status text names the state, the facts and the hint", () => {
  const text = formatPower(STATUS).join("\n");
  assert.match(text, /^awake {3}working · holding the Mac awake \(working: 1 model call running\)$/m);
  assert.match(text, /battery 55% \(on power\) · thermal normal · lid closed/);
  assert.match(text, /^tether {2}on · hotspot · hotspot-not-visible · hotspot "PBJ"$/m);
  assert.match(text, /last probe FAILED/);
  assert.match(text, /→ Open Personal Hotspot/);
  assert.match(formatPower({ ...STATUS, awake: { ...STATUS.awake, setup: "needs-setup" } }).join("\n"), /needs setup: clauderipple awake setup/);
});

test("a conflict is named under the awake line in one line: the known app, the unknown cause, and an old router's string", () => {
  const known = formatPower({ ...STATUS, awake: { ...STATUS.awake, conflict: { app: "aldente", name: "AlDente", at: "2026-10-20T03:00:00.000Z" } } }).join("\n");
  assert.match(known, /^ {8}conflict: AlDente also changes the sleep setting$/m);
  const unknown = formatPower({ ...STATUS, awake: { ...STATUS.awake, conflict: { app: null, name: null, at: "2026-10-20T03:00:00.000Z" } } }).join("\n");
  assert.match(unknown, /^ {8}conflict: sleep was re-enabled outside ClaudeRipple at .+ by another app or a settings change$/m);
  // A router of 0.12.22 sent the old string, which names the one app there was.
  const old = formatPower({ ...STATUS, awake: { ...STATUS.awake, conflict: "aldente-disable-sleep" } } as unknown as PowerStatus).join("\n");
  assert.match(old, /^ {8}conflict: AlDente also changes the sleep setting$/m);
  // An older router sends no conflict field at all.
  assert.doesNotMatch(formatPower(STATUS).join("\n"), /conflict:/);
  const older = { platform: STATUS.platform, awake: { mode: STATUS.awake.mode }, tether: STATUS.tether } as unknown as PowerStatus;
  assert.doesNotMatch(formatPower(older).join("\n"), /conflict:/);
});

function rig(answer: "router" | "down") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-power-cli-"));
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ listen: { port: 8791 } }));
  const sent: { method: string; body?: PowerChange }[] = [];
  const runs: string[] = [];
  const printed: string[] = [];
  const call: PowerCall = async (method, body) => {
    sent.push({ method, ...(body ? { body } : {}) });
    return answer === "down" ? null : { status: 200, json: STATUS };
  };
  const d: PowerCliDeps = {
    call,
    configFile,
    rippleHome: dir,
    run: async (f, a): Promise<RunResult> => (runs.push([f, ...a].join(" ")), { code: 0, stdout: "", stderr: "" }),
    setupDeps: () => { throw new Error("not in this test"); },
    print: (l) => void printed.push(l),
    now: () => new Date(2026, 9, 20, 17, 0),
  };
  return { d, sent, runs, printed, configFile, dir };
}

test("awake/tether changes go through the router's API", async () => {
  const r = rig("router");
  assert.equal(await powerCli(["awake", "working", "--until", "18:30"], r.d), 0);
  assert.deepEqual(r.sent[0], { method: "PUT", body: { awake: { mode: "working", until: new Date(2026, 9, 20, 18, 30).toISOString() } } });
  assert.equal(await powerCli(["awake", "on"], r.d), 0);
  assert.deepEqual(r.sent[1]!.body, { awake: { mode: "on", until: null } }, "a new mode without --until clears an old one");
  assert.equal(await powerCli(["tether", "on"], r.d), 0);
  assert.deepEqual(r.sent[2]!.body, { tether: { enabled: true } });
  assert.equal(await powerCli(["power", "--json"], r.d), 0);
  assert.deepEqual(JSON.parse(r.printed.at(-1)!), STATUS);
  assert.equal(await powerCli(["awake", "off", "--until", "18:00"], r.d), 1);
  assert.equal(await powerCli(["tether", "maybe"], r.d), 1);
});

test("with no router: saved to config.json, and awake off clears a bit the router left set", async () => {
  const r = rig("down");
  fs.writeFileSync(path.join(r.dir, "awake.json"), JSON.stringify({ applied: true, since: "x", reason: "on" }));
  // Only darwin clears the bit; elsewhere releaseAwake reports nothing held.
  assert.equal(await powerCli(["awake", "off"], r.d), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, "utf8")).awake, { mode: "off" });
  if (process.platform === "darwin") assert.deepEqual(r.runs, ["/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"]);
  else assert.deepEqual(r.runs, []);
  assert.equal(await powerCli(["tether", "on"], r.d), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, "utf8")).tether, { enabled: true });
  assert.equal(await powerCli(["power"], r.d), 1, "status needs the router");
});

test("awake setup --ssid saves the hotspot name after a successful setup", async () => {
  const r = rig("router");
  const setup: SetupDeps = {
    platform: "darwin",
    run: async (f) => ({ code: 0, stdout: f === "/usr/sbin/networksetup" ? "Hardware Port: Wi-Fi\nDevice: en0\n" : "", stderr: "" }),
    user: "u", uid: 501, home: "/Users/u", rippleHome: r.dir,
    exists: () => false,
    writeTemp: () => "/tmp/x/clauderipple",
    removeTemp: () => {},
    trashFallback: () => {},
    print: (l) => void r.printed.push(l),
  };
  r.d.setupDeps = () => setup;
  assert.equal(await powerCli(["awake", "setup", "--ssid", "PBJ"], r.d), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, "utf8")).tether, { hotspotSsid: "PBJ" });
  assert.equal(await powerCli(["awake", "setup", "--ssid"], r.d), 1);
});
