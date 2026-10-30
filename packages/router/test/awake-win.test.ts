import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HELPER_CS, LIDACTION, LineHelper, SUB_BUTTONS, WIN_SLEEP_SETTLE_MS, helperBattery, helperScript, lidWriteArgs, parseHelperReply, parseLidAction,
  powershellEnv, psArgs, restoreLidFromJournal, type ExecStateHelper, type HelperCommand, type HelperReply,
} from "../src/awake-win.ts";
import { AwakeController, readJournal, type Activity, type AwakeJournal, type RunResult } from "../src/awake.ts";
import { AWAKE_DEFAULTS, type AwakeSettings } from "../src/config.ts";
import { powerPlatform } from "../src/power.ts";

// powercfg's documented layout (Microsoft Learn, powercfg /query). Not measured: the Windows VM was
// not reachable when this was written — see the ARCHITECTURE §8 Windows notes.
const SCHEME = "381b4222-f694-41f0-9685-ff5bb260df2e";
const query = (ac: number, dc: number, scheme = SCHEME): string => `Power Scheme GUID: ${scheme}  (Balanced)
  Subgroup GUID: ${SUB_BUTTONS}  (Power buttons and lid)
    GUID Alias: SUB_BUTTONS
    Power Setting GUID: ${LIDACTION}  (Lid close action)
      GUID Alias: LIDACTION
      Possible Setting Index: 000
      Possible Setting Friendly Name: Do nothing
      Possible Setting Index: 001
      Possible Setting Friendly Name: Sleep
      Possible Setting Index: 002
      Possible Setting Friendly Name: Hibernate
      Possible Setting Index: 003
      Possible Setting Friendly Name: Shut down
    Current AC Power Setting Index: 0x0000000${ac}
    Current DC Power Setting Index: 0x0000000${dc}
`;
// The same with translated labels: only GUIDs and hex indexes are read.
const QUERY_KO = `전원 구성표 GUID: ${SCHEME}  (균형 조정)
  하위 그룹 GUID: ${SUB_BUTTONS}  (전원 단추 및 덮개)
    GUID 별칭: SUB_BUTTONS
    전원 설정 GUID: ${LIDACTION}  (덮개를 닫으면)
      GUID 별칭: LIDACTION
      가능한 설정 인덱스: 000
      가능한 설정 이름: 아무 것도 안 함
    현재 AC 전원 설정 인덱스: 0x00000001
    현재 DC 전원 설정 인덱스: 0x00000002
`;

test("lid action: scheme and AC/DC indexes from GUIDs and hex only, in any display language", () => {
  assert.deepEqual(parseLidAction(query(1, 1)), { scheme: SCHEME, ac: 1, dc: 1 });
  assert.deepEqual(parseLidAction(QUERY_KO), { scheme: SCHEME, ac: 1, dc: 2 });
  assert.equal(parseLidAction(`Power Scheme GUID: ${SCHEME}  (Balanced)\n`), null, "a desktop without the setting");
  assert.equal(parseLidAction(query(1, 1).replace(LIDACTION, "11111111-2222-3333-4444-555555555555")), null, "another setting");
  assert.equal(parseLidAction(query(1, 1).replace("0x00000001\n    Current DC", "0x00000009\n    Current DC")), null, "out of range");
});

test("lid writes: AC, DC, then re-activate whatever plan is active; nothing else gets through", () => {
  assert.deepEqual(lidWriteArgs(SCHEME, 0, 0), [
    ["/setacvalueindex", SCHEME, SUB_BUTTONS, LIDACTION, "0"],
    ["/setdcvalueindex", SCHEME, SUB_BUTTONS, LIDACTION, "0"],
    ["/setactive", "SCHEME_CURRENT"],
  ]);
  assert.throws(() => lidWriteArgs("SCHEME_CURRENT & calc", 0, 0));
  assert.throws(() => lidWriteArgs(SCHEME, 4, 0));
  assert.throws(() => lidWriteArgs(SCHEME, 0, -1));
});

test("the helper program: encoded for -EncodedCommand, C# 5 only, P/Invoke of the documented calls", () => {
  const script = helperScript();
  const args = psArgs(script);
  assert.deepEqual(args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.equal(Buffer.from(args[6]!, "base64").toString("utf16le"), script);
  assert.ok(args.join(" ").length < 32_000, "fits a Windows command line");
  assert.match(script, /^Add-Type -IgnoreWarnings -TypeDefinition @'$/m);
  assert.match(script, /^'@$/m, "here-string terminator at the start of a line");
  assert.match(script, /exit \(\[ClaudeRippleAwake\]::Run\(\)\)/);
  // Windows PowerShell 5.1 compiles C# 5: no interpolated strings, no null-conditional operators.
  assert.doesNotMatch(HELPER_CS, /\$"|\?\.|\?\[|=>/);
  for (const name of ["SetThreadExecutionState", "GetSystemPowerStatus", "GetPwrCapabilities", "SetSuspendState", "PowerSettingRegisterNotification", "AdjustTokenPrivileges"]) {
    assert.ok(HELPER_CS.includes(name), name);
  }
  assert.ok(HELPER_CS.includes("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3"), "GUID_LIDSWITCH_STATE_CHANGE");
  assert.ok(HELPER_CS.includes("ES_CONTINUOUS | ES_SYSTEM_REQUIRED"));
  assert.doesNotMatch(HELPER_CS, /ES_DISPLAY_REQUIRED|ES_AWAYMODE/, "the display may sleep; away mode is for media PCs");
  assert.doesNotMatch(helperScript(), /rundll32/);
  assert.equal(Object.keys(powershellEnv({ PSModulePath: "x", psmodulepath: "y", Path: "p" })).join(), "Path");
});

test("helper replies: battery and AC, a PC without a battery, and garbage", () => {
  const r = parseHelperReply('{"ok":true,"held":true,"lid":"closed","ac":false,"battery":true,"percent":15,"lidPresent":true,"s3":true,"hiberFile":false,"aoac":false}')!;
  assert.equal(r.lid, "closed");
  assert.deepEqual(helperBattery(r), { percent: 15, onBattery: true });
  const desk = parseHelperReply('{"ok":true,"held":false,"lid":null,"ac":true,"battery":false,"percent":null,"lidPresent":false,"s3":true,"hiberFile":true,"aoac":false}')!;
  assert.deepEqual(helperBattery(desk), { percent: null, onBattery: false });
  const unknownAc = parseHelperReply('{"ok":true,"held":false,"lid":null,"ac":null,"battery":true,"percent":50,"lidPresent":true,"s3":false,"hiberFile":false,"aoac":true}')!;
  assert.deepEqual(helperBattery(unknownAc), { percent: 50, onBattery: false }, "AC unknown is not treated as on battery");
  assert.equal(parseHelperReply("Add-Type : Cannot add type"), null);
  assert.equal(parseHelperReply('{"ok":true}'), null);
  assert.equal(parseHelperReply('{"ok":false,"held":false,"error":"lid notification 5"}')?.error, "lid notification 5");
});

// A Node stand-in for the PowerShell child: same line protocol, so the Node side runs for real.
const IMPOSTOR = `
let held = false;
const reply = (extra) => process.stdout.write(JSON.stringify({ ok: true, held, lid: "open", ac: true, battery: true, percent: 80, lidPresent: true, s3: true, hiberFile: true, aoac: false, ...extra }) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (cmd === "hold") held = true;
    if (cmd === "release") held = false;
    if (cmd === "die") { process.stderr.write("Add-Type : compilation failed\\n"); process.exit(3); }
    if (cmd === "status" || cmd === "hold" || cmd === "release") reply({});
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const impostor = () => spawn(process.execPath, ["-e", IMPOSTOR], { stdio: ["pipe", "pipe", "pipe"] });

test("LineHelper: one answer per command in order; exits when stdin closes; a dead child says why", async () => {
  const h = new LineHelper(impostor);
  const [a, b, c] = await Promise.all([h.send("status"), h.send("hold"), h.send("status")]);
  assert.deepEqual([a.held, b.held, c.held], [false, true, true]);
  assert.equal(h.alive, true);
  h.close();
  for (let i = 0; i < 50 && h.alive; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.alive, false, "EOF on stdin ends the child, as a dead router's pipe does");
  await assert.rejects(h.send("status"), /not running/);
  const d = new LineHelper(impostor);
  await assert.rejects(d.send("die" as HelperCommand), /exited \(3\): Add-Type : compilation failed/);
});

// ---- Controller on a fake Windows ----------------------------------------------------------------

type FakeWin = {
  calls: string[];
  lid: { scheme: string; ac: number; dc: number };
  /** No lid setting at all (a desktop). */
  desktop: boolean;
  writeFails: string | null;
  helper: { held: boolean; lid: "open" | "closed" | null; ac: boolean; percent: number; s3: boolean; aoac: boolean; hiberFile: boolean; dead: boolean };
  helperLog: string[];
  spawns: number;
  /** The journal as it was on disk when "Do nothing" was written. */
  journalAtWrite: AwakeJournal | null;
};

function fakeWin(journalFile: string, over: Partial<Omit<FakeWin, "helper">> & { helper?: Partial<FakeWin["helper"]> } = {}) {
  const w: FakeWin = {
    calls: [],
    lid: { scheme: SCHEME, ac: 1, dc: 1 },
    desktop: false,
    writeFails: null,
    helperLog: [],
    spawns: 0,
    journalAtWrite: null,
    ...over,
    helper: { held: false, lid: "open", ac: true, percent: 80, s3: true, aoac: false, hiberFile: true, dead: false, ...over.helper },
  };
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const run = async (file: string, args: string[]): Promise<RunResult> => {
    assert.match(file, /powercfg\.exe$/i, `only powercfg runs: ${file}`);
    const line = args.join(" ");
    w.calls.push(line);
    if (args[0] === "/q" || args[0] === "/qh") return w.desktop ? ok(`Power Scheme GUID: ${w.lid.scheme}  (Balanced)\n`) : ok(query(w.lid.ac, w.lid.dc, w.lid.scheme));
    if (args[0] === "/setacvalueindex" || args[0] === "/setdcvalueindex") {
      if (w.writeFails) return { code: 1, stdout: w.writeFails, stderr: "" };
      if (args[1] === w.lid.scheme) {
        if (args[4] === "0" && !w.journalAtWrite) w.journalAtWrite = readJournal(journalFile);
        if (args[0] === "/setacvalueindex") w.lid.ac = Number(args[4]);
        else w.lid.dc = Number(args[4]);
      }
      return ok();
    }
    if (line === "/setactive SCHEME_CURRENT") return ok();
    throw new Error(`unexpected powercfg ${line}`);
  };
  const helper = (): ExecStateHelper => {
    w.spawns++;
    w.helper.held = false; // a new child holds nothing
    let alive = true;
    return {
      get alive() {
        return alive && !w.helper.dead;
      },
      send: async (cmd: HelperCommand): Promise<HelperReply> => {
        if (w.helper.dead) throw new Error("keep-awake helper exited (1): Add-Type : blocked");
        w.helperLog.push(cmd);
        if (cmd === "hold") w.helper.held = true;
        if (cmd === "release") w.helper.held = false;
        const h = w.helper;
        return { ok: true, held: h.held, lid: h.lid, ac: h.ac, battery: true, percent: h.percent, lidPresent: true, s3: h.s3, hiberFile: h.hiberFile, aoac: h.aoac };
      },
      close: () => {
        alive = false;
        w.helperLog.push("close");
      },
    };
  };
  return { w, run, helper };
}

const NOW = Date.parse("2026-10-20T12:00:00Z");

function winController(o: { settings: () => AwakeSettings; activity?: () => Activity; journalFile?: string; clock?: { t: number }; fake?: Parameters<typeof fakeWin>[1] }) {
  const clock = o.clock ?? { t: NOW };
  const journalFile = o.journalFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-win-")), "awake.json");
  const f = fakeWin(journalFile, o.fake);
  const lines: string[] = [];
  const c = new AwakeController({
    platform: "win32",
    run: f.run,
    settings: o.settings,
    activity: o.activity ?? (() => ({ inFlight: 0 })),
    journalFile,
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    schedule: () => () => {},
    winHelper: f.helper,
  });
  return { c, ...f, clock, journalFile, lines };
}

const settings = (s: Partial<AwakeSettings>) => () => ({ ...AWAKE_DEFAULTS, ...s });

test("Windows, mode off with nothing held: no child, no command; setup is ok with no prompt", async () => {
  const t = winController({ settings: settings({ mode: "off" }) });
  await t.c.start();
  assert.equal(t.w.spawns, 0);
  assert.deepEqual(t.w.calls, []);
  assert.equal(t.c.status().setup, "ok");
  // Working but idle: still nothing to hold, so still no child.
  const u = winController({ settings: settings({ mode: "working" }) });
  await u.c.tick();
  assert.equal(u.w.spawns, 0);
});

test("Windows, working: a call holds the PC (journal with the user's lid action first, then Do nothing), idle restores it", async () => {
  let activity: Activity = { inFlight: 1 };
  const t = winController({ settings: settings({ mode: "working" }), activity: () => activity });
  await t.c.tick();
  assert.ok(t.w.helperLog.includes("hold"));
  assert.deepEqual(t.w.lid, { scheme: SCHEME, ac: 0, dc: 0 });
  assert.deepEqual(t.w.journalAtWrite?.lid, { scheme: SCHEME, ac: 1, dc: 1 }, "the user's values were on disk before powercfg changed them");
  assert.equal(t.w.journalAtWrite?.applied, true);
  assert.equal(t.c.status().applied, true);
  assert.equal(t.c.status().thermal, "unknown");
  assert.deepEqual(t.c.status().battery, { percent: 80, onBattery: false });
  activity = { inFlight: 0, lastStartedAt: NOW, lastEndedAt: NOW };
  t.clock.t = NOW + 11 * 60_000;
  await t.c.tick();
  assert.deepEqual(t.w.lid, { scheme: SCHEME, ac: 1, dc: 1 }, "restored");
  assert.ok(t.w.helperLog.includes("release"));
  assert.equal(t.c.status().applied, false);
  const j = readJournal(t.journalFile)!;
  assert.equal(j.applied, false);
  assert.equal(j.lid, undefined);
  assert.ok(!t.w.helperLog.includes("sleep"), "lid open: nothing slept");
  assert.equal(t.w.helperLog.at(-1), "close", "the child goes once nothing is held");
});

test("Windows, releasing with the lid closed follows the user's own lid action, never on Modern Standby", async () => {
  const run = async (fake: Parameters<typeof fakeWin>[1]) => {
    let mode: AwakeSettings["mode"] = "on";
    const t = winController({ settings: () => ({ ...AWAKE_DEFAULTS, mode }), fake });
    await t.c.tick();
    t.w.helper.lid = "closed";
    mode = "off";
    const before = t.clock.t;
    await t.c.tick();
    return { ...t, waited: t.clock.t - before };
  };
  const sleep = await run({});
  assert.deepEqual(sleep.w.helperLog.slice(-4), ["release", "status", "sleep", "close"]);
  assert.equal(sleep.waited, WIN_SLEEP_SETTLE_MS);
  assert.ok(sleep.lines.some((l) => /sleeping now/.test(l)));
  const onBattery = await run({ lid: { scheme: SCHEME, ac: 0, dc: 2 }, helper: { ac: false } });
  assert.ok(onBattery.w.helperLog.includes("hibernate"), "DC action on battery");
  const modern = await run({ helper: { aoac: true, s3: false } });
  assert.ok(!modern.w.helperLog.includes("sleep"));
  assert.ok(modern.lines.some((l) => /Modern Standby/.test(l)));
  const nothing = await run({ lid: { scheme: SCHEME, ac: 0, dc: 0 } });
  assert.ok(!nothing.w.helperLog.includes("sleep") && !nothing.w.helperLog.includes("hibernate"), "the user's own Do nothing is respected");
});

test("Windows restart in working mode: the lid action stays, the new child holds again, nothing is restored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-win-"));
  const journalFile = path.join(dir, "awake.json");
  const clock = { t: NOW };
  const first = winController({ settings: settings({ mode: "working" }), activity: () => ({ inFlight: 1, lastStartedAt: NOW }), journalFile, clock });
  await first.c.tick();
  first.c.beforeExit();
  assert.equal(first.w.helperLog.at(-1), "close", "exit closes the child (the hold goes with it)");
  assert.equal(readJournal(journalFile)?.applied, true);
  clock.t += 30_000;
  const second = winController({ settings: settings({ mode: "working" }), journalFile, clock, fake: { lid: { scheme: SCHEME, ac: 0, dc: 0 } } });
  await second.c.start();
  assert.ok(second.w.helperLog.includes("hold"), "the successor's child holds again");
  assert.ok(!second.w.calls.some((l) => l.startsWith("/setacvalueindex")), "no restore, no rewrite");
  assert.equal(second.c.status().applied, true);
  assert.deepEqual(readJournal(journalFile)?.lid, { scheme: SCHEME, ac: 1, dc: 1 }, "still knows what to restore");
});

test("Windows start with a journaled hold that is no longer wanted restores the user's lid action", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-win-"));
  const journalFile = path.join(dir, "awake.json");
  fs.writeFileSync(journalFile, JSON.stringify({ applied: true, since: "x", reason: "on", lid: { scheme: SCHEME, ac: 2, dc: 1 } }));
  const t = winController({ settings: settings({ mode: "off" }), journalFile, fake: { lid: { scheme: SCHEME, ac: 0, dc: 0 } } });
  await t.c.start();
  assert.deepEqual(t.w.lid, { scheme: SCHEME, ac: 2, dc: 1 });
  assert.equal(readJournal(journalFile)?.applied, false);
});

test("Windows: a lid action changed by the user while held becomes theirs; a switched plan gets ours undone", async () => {
  const t = winController({ settings: settings({ mode: "on" }) });
  await t.c.tick();
  t.w.lid = { scheme: SCHEME, ac: 3, dc: 3 }; // the user chose "Shut down" in Control Panel
  await t.c.tick();
  assert.deepEqual(t.w.lid, { scheme: SCHEME, ac: 0, dc: 0 }, "still wanted: set again");
  assert.deepEqual(readJournal(t.journalFile)?.lid, { scheme: SCHEME, ac: 3, dc: 3 }, "their new choice is what gets restored");
  // Nothing else writes the lid action, so a change outside us is an unknown cause (no reboot exception).
  assert.deepEqual(t.c.status().conflict, { app: null, name: null, at: new Date(NOW).toISOString() });
  assert.ok(t.lines.includes("awake: sleep was re-enabled outside ClaudeRipple (another app or a settings change)"));
  const other = "a1841308-3541-4fab-bc81-f71556f20b4a";
  t.w.lid = { scheme: other, ac: 1, dc: 1 };
  t.w.calls.length = 0;
  await t.c.tick();
  assert.ok(t.w.calls.includes(`/setacvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 3`), "the old plan gets the user's value back");
  assert.deepEqual(readJournal(t.journalFile)?.lid, { scheme: other, ac: 1, dc: 1 });
});

test("Windows: a plan Group Policy locks is reported, left as it was, and not recorded as held", async () => {
  const t = winController({ settings: settings({ mode: "on" }), fake: { writeFails: "You don't have permission to change this setting (Group Policy)." } });
  await t.c.tick();
  const s = t.c.status();
  assert.equal(s.applied, false);
  assert.match(s.reason, /Group Policy/);
  assert.equal(s.setup, "ok", "there is no setup that would fix a policy");
  assert.equal(readJournal(t.journalFile)?.applied, false);
  assert.ok(t.w.helperLog.includes("release"), "the execution state is not left held either");
});

test("Windows guards: battery below the floor releases; a child that cannot start is retried once a minute", async () => {
  const t = winController({ settings: settings({ mode: "on" }) });
  await t.c.tick();
  assert.equal(t.c.status().applied, true);
  t.w.helper.ac = false;
  t.w.helper.percent = 15;
  await t.c.tick();
  assert.equal(t.c.status().applied, false);
  assert.match(t.c.status().reason, /battery 15% is below 20%/);

  const u = winController({ settings: settings({ mode: "on" }), fake: { helper: { dead: true } } });
  await u.c.tick();
  assert.match(u.c.status().reason, /^error: keep-awake helper exited \(1\): Add-Type : blocked/);
  const spawns = u.w.spawns;
  u.clock.t += 15_000;
  await u.c.tick();
  assert.equal(u.w.spawns, spawns, "not respawned within the minute");
  assert.match(u.c.status().reason, /Add-Type : blocked/, "the reason stays");
  u.clock.t += 60_000;
  await u.c.tick();
  assert.equal(u.w.spawns, spawns + 1);
});

test("Windows desktop (no lid setting): only idle sleep is held, no powercfg write", async () => {
  const t = winController({ settings: settings({ mode: "on" }), fake: { desktop: true } });
  await t.c.tick();
  assert.equal(t.c.status().applied, true);
  assert.ok(!t.w.calls.some((l) => l.startsWith("/set")));
  assert.deepEqual(t.w.calls, [`/q SCHEME_CURRENT ${SUB_BUTTONS} ${LIDACTION}`, `/qh SCHEME_CURRENT ${SUB_BUTTONS} ${LIDACTION}`]);
});

test("restoreLidFromJournal and the platform field", async () => {
  const calls: string[] = [];
  const run = async (_f: string, a: string[]): Promise<RunResult> => (calls.push(a.join(" ")), { code: 0, stdout: "", stderr: "" });
  assert.equal(await restoreLidFromJournal(run, null), "not-held");
  assert.equal(await restoreLidFromJournal(run, { applied: true, since: "", reason: "" }), "not-held");
  assert.deepEqual(calls, []);
  assert.equal(await restoreLidFromJournal(run, { applied: true, since: "", reason: "", lid: { scheme: SCHEME, ac: 1, dc: 2 } }), "released");
  assert.deepEqual(calls, [`/setacvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 1`, `/setdcvalueindex ${SCHEME} ${SUB_BUTTONS} ${LIDACTION} 2`, "/setactive SCHEME_CURRENT"]);
  assert.deepEqual([powerPlatform("darwin"), powerPlatform("win32"), powerPlatform("linux"), powerPlatform("freebsd")], ["darwin", "win32", "linux", "linux"]);
});
