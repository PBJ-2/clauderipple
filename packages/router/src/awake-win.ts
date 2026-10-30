// Lid-closed awake on Windows (awake.ts holds the shared decision, journal and controller).
//
// Two things keep a Windows laptop running with its lid closed while Claude works:
//
//   1. The idle sleep timer. `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` holds it
//      off for as long as the calling thread keeps that state (Microsoft Learn, SetThreadExecutionState).
//      Node cannot call it, so a small PowerShell child the router owns does (Add-Type P/Invoke, one
//      dedicated thread, like PowerToys Awake's own monitor thread — behavioural reference only). The
//      child reads commands on stdin and exits when stdin closes, which is what happens when the
//      router dies for any reason; the execution state goes with its thread.
//   2. The lid. "SetThreadExecutionState cannot be used to prevent the user from putting the computer
//      to sleep … when they close the lid" (same page), so while held the active power plan's
//      lid-close action (SUB_BUTTONS/LIDACTION, 0 = Do nothing) is set to 0 on AC and battery with
//      `powercfg`, and the user's own values are put back on release. They are kept in the journal
//      (`<home>/awake.json`, field `lid`) before anything is changed, so a router that died holding
//      them restores them on its next start, and `clauderipple stop|uninstall|awake off` restore them
//      with no router at all. Power plans carry one ACL that gives Authenticated Users read/write
//      ("Administrator Overrides", Microsoft Learn): no elevation; a Group Policy override is
//      reported, not fought.
//
// The same child reports the lid (PowerSettingRegisterNotification(GUID_LIDSWITCH_STATE_CHANGE,
// DEVICE_NOTIFY_CALLBACK) — no window needed, and "immediately after registration, the callback will
// be invoked with the current value"), AC/battery (GetSystemPowerStatus) and what the machine can do
// (GetPwrCapabilities: lid present, S3, hibernate file, AoAc = Modern Standby). Thermal state is not
// readable without administrator rights on Windows (root\wmi thermal zones), so it is "unknown",
// which decideAwake reports and does not act on.
//
// Releasing with the lid closed: Windows acts on the lid only when it moves, so a laptop released
// in a bag would keep running until its idle timer sleeps it. If the user's restored action for the
// current power source is Sleep and the machine has S3 and is not Modern Standby, the child calls
// SetSuspendState(FALSE) (with SeShutdownPrivilege enabled, as its docs require); Hibernate likewise
// with a hibernation file present. Never `rundll32 powrprof.dll,SetSuspendState`: rundll32 passes
// its own argument layout, not three BOOLEANs. On Modern Standby the effect of SetSuspendState is
// not documented, so nothing is called there and Windows' idle timer does it (logged).
//
// Every command goes through the injected Runner; the child through an injected spawn. Tests run on
// any OS against fakes.

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { AwakeBackend, AwakeJournal, Battery, ConflictApp, Guards, HoldOutcome, LidAction, Runner } from "./awake.ts";

const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
export const POWERCFG = path.win32.join(SYSTEM_ROOT, "System32", "powercfg.exe");
export const POWERSHELL = path.win32.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** Locale-independent identifiers (Microsoft Learn, "Lid switch close action"). */
export const SUB_BUTTONS = "4f971e89-eebd-4455-a8de-9e59040e7347";
export const LIDACTION = "5ca83367-6e45-459f-a27b-476b1d01c936";
export const LID_DO_NOTHING = 0;
export const LID_SLEEP = 1;
export const LID_HIBERNATE = 2;

/**
 * process.env minus PSModulePath (matched without regard to case). From a PowerShell 7 terminal the
 * chain pwsh → node → powershell.exe would otherwise hand Windows PowerShell 5.1 the 7.x copies of
 * its own modules (cli/windows-powershell.ts, issue #35).
 */
export function powershellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
}

/** Arguments for a one-shot Windows PowerShell command. */
export function psArgs(command: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

// ---- powercfg ------------------------------------------------------------------------------------

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * `powercfg /q SCHEME_CURRENT <SUB_BUTTONS> <LIDACTION>`. Its labels are translated
 * ("Power Scheme GUID", "Current AC Power Setting Index", …), so only what does not change with
 * the display language is read: the first GUID (the scheme), the setting's own GUID (to be sure it
 * is the lid action), and the two hexadecimal indexes, which powercfg prints AC first, then DC.
 *   Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
 *     …
 *       Current AC Power Setting Index: 0x00000001
 *       Current DC Power Setting Index: 0x00000001
 * The "Possible Setting Index" lines are decimal (000), not 0x, and are skipped by that.
 */
export function parseLidAction(text: string): LidAction | null {
  const scheme = GUID.exec(text)?.[0]?.toLowerCase();
  if (!scheme || !text.toLowerCase().includes(LIDACTION)) return null;
  const indexes = [...text.matchAll(/:\s*0x([0-9a-f]{1,8})\s*$/gim)].map((m) => parseInt(m[1]!, 16));
  if (indexes.length < 2) return null;
  const [ac, dc] = indexes.slice(-2) as [number, number];
  if (ac > 3 || dc > 3) return null;
  return { scheme, ac, dc };
}

export function lidQueryArgs(hidden = false): string[] {
  return [hidden ? "/qh" : "/q", "SCHEME_CURRENT", SUB_BUTTONS, LIDACTION];
}

/** The commands that set a scheme's lid action on AC and battery and make it take effect. */
export function lidWriteArgs(scheme: string, ac: number, dc: number): string[][] {
  if (!GUID.test(scheme) || scheme.length !== 36) throw new Error(`unexpected power scheme "${scheme}"`);
  for (const v of [ac, dc]) if (!Number.isInteger(v) || v < 0 || v > 3) throw new Error(`unexpected lid action ${v}`);
  return [
    ["/setacvalueindex", scheme, SUB_BUTTONS, LIDACTION, String(ac)],
    ["/setdcvalueindex", scheme, SUB_BUTTONS, LIDACTION, String(dc)],
    // Changes to the active scheme take effect when it is (re)activated. SCHEME_CURRENT, not our
    // scheme: if the user switched plans meanwhile, theirs stays active.
    ["/setactive", "SCHEME_CURRENT"],
  ];
}

/** Reads the active scheme's lid action: null when this PC has none (a desktop) or it cannot be read. */
export async function readLidAction(run: Runner): Promise<{ lid: LidAction | null; error?: string }> {
  const r = await run(POWERCFG, lidQueryArgs());
  if (r.code === 0) {
    const lid = parseLidAction(r.stdout);
    if (lid) return { lid };
  }
  // A setting a PC has no hardware for can be hidden from /q; /qh lists hidden settings too.
  const h = await run(POWERCFG, lidQueryArgs(true));
  if (h.code === 0) return { lid: parseLidAction(h.stdout) };
  return { lid: null, error: (r.stderr || r.stdout || h.stderr || h.stdout).trim().slice(0, 200) || `powercfg exited ${r.code}` };
}

/** Writes a scheme's lid action. Returns the error text, or null. */
export async function writeLidAction(run: Runner, scheme: string, ac: number, dc: number): Promise<string | null> {
  for (const args of lidWriteArgs(scheme, ac, dc)) {
    const r = await run(POWERCFG, args);
    if (r.code !== 0) return (r.stderr || r.stdout).trim().slice(0, 200) || `powercfg ${args[0]} exited ${r.code}`;
  }
  return null;
}

// ---- The execution-state child -------------------------------------------------------------------

/**
 * C# 5 (what Windows PowerShell 5.1's Add-Type compiles): no interpolated strings, no `?.`.
 * Protocol: one command per stdin line (status | hold | release | sleep | hibernate), one JSON line
 * back per command. EOF on stdin = the router is gone: exit, which drops the execution state.
 */
export const HELPER_CS = String.raw`
// Struct fields filled by the marshaller read as "never assigned" (CS0649); Add-Type may treat that as an error.
#pragma warning disable 649, 169, 414
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class ClaudeRippleAwake {
  const uint ES_CONTINUOUS = 0x80000000;
  const uint ES_SYSTEM_REQUIRED = 0x00000001;
  const uint PBT_POWERSETTINGCHANGE = 0x8013;
  const uint DEVICE_NOTIFY_CALLBACK = 2;

  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint esFlags);

  [StructLayout(LayoutKind.Sequential)]
  struct SYSTEM_POWER_STATUS { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; }
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

  [DllImport("powrprof.dll")] [return: MarshalAs(UnmanagedType.U1)] static extern bool GetPwrCapabilities([In, Out] byte[] capabilities);
  [DllImport("powrprof.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)]
  static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)] bool hibernate, [MarshalAs(UnmanagedType.U1)] bool force, [MarshalAs(UnmanagedType.U1)] bool wakeupEventsDisabled);

  delegate uint NotifyCallback(IntPtr context, uint type, IntPtr setting);
  [DllImport("powrprof.dll")] static extern uint PowerSettingRegisterNotification(ref Guid settingGuid, uint flags, IntPtr recipient, out IntPtr registrationHandle);

  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID Luid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string systemName, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES state, uint length, IntPtr previous, IntPtr returnLength);

  static readonly AutoResetEvent wanted = new AutoResetEvent(false);
  static readonly AutoResetEvent applied = new AutoResetEvent(false);
  static volatile bool want;
  static volatile bool held;
  static volatile int lid = -1;
  static NotifyCallback keepAlive;
  static byte[] caps = new byte[256];

  // One thread owns the execution state, so it is never lost to whichever thread PowerShell runs on.
  static void HoldLoop() {
    while (true) {
      wanted.WaitOne();
      bool w = want;
      // Returns the previous state, and NULL on failure — which valid flags do not produce, and a
      // thread's first call may legitimately return; so the request itself is what is reported.
      SetThreadExecutionState(w ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) : ES_CONTINUOUS);
      held = w;
      applied.Set();
    }
  }

  static void SetHold(bool on) {
    want = on;
    wanted.Set();
    applied.WaitOne(5000);
  }

  static uint OnSetting(IntPtr context, uint type, IntPtr setting) {
    try {
      // POWERBROADCAST_SETTING: GUID (16 bytes), DWORD DataLength, then Data (0 closed, 1 open).
      if (type == PBT_POWERSETTINGCHANGE && setting != IntPtr.Zero && Marshal.ReadInt32(setting, 16) >= 4) lid = Marshal.ReadInt32(setting, 20);
    } catch (Exception) { }
    return 0;
  }

  static string WatchLid() {
    keepAlive = new NotifyCallback(OnSetting);
    // DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback, Context }, kept in unmanaged memory for the process's life.
    IntPtr parameters = Marshal.AllocHGlobal(IntPtr.Size * 2);
    Marshal.WriteIntPtr(parameters, 0, Marshal.GetFunctionPointerForDelegate(keepAlive));
    Marshal.WriteIntPtr(parameters, IntPtr.Size, IntPtr.Zero);
    Guid lidSwitch = new Guid("BA3E0F4D-B817-4094-A2D1-D56379E6A0F3");
    IntPtr registration;
    uint rc = PowerSettingRegisterNotification(ref lidSwitch, DEVICE_NOTIFY_CALLBACK, parameters, out registration);
    return rc == 0 ? null : "lid notification " + rc;
  }

  static string EnableShutdownPrivilege() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0028, out token)) return "OpenProcessToken " + Marshal.GetLastWin32Error();
    try {
      TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
      tp.PrivilegeCount = 1;
      tp.Attributes = 2;
      if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out tp.Luid)) return "LookupPrivilegeValue " + Marshal.GetLastWin32Error();
      if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return "AdjustTokenPrivileges " + Marshal.GetLastWin32Error();
      int last = Marshal.GetLastWin32Error();
      return last == 0 ? null : "SeShutdownPrivilege not held (" + last + ")";
    } finally { CloseHandle(token); }
  }

  static string B(bool v) { return v ? "true" : "false"; }

  static string Status(string error) {
    SYSTEM_POWER_STATUS s;
    bool ok = GetSystemPowerStatus(out s);
    string ac = !ok || s.ACLineStatus == 255 ? "null" : B(s.ACLineStatus == 1);
    bool battery = ok && s.BatteryFlag != 255 && (s.BatteryFlag & 128) == 0;
    string percent = battery && s.BatteryLifePercent <= 100 ? s.BatteryLifePercent.ToString() : "null";
    string lidText = lid == 0 ? "\"closed\"" : lid == 1 ? "\"open\"" : "null";
    return "{\"ok\":" + B(error == null) + ",\"held\":" + B(held) + ",\"lid\":" + lidText + ",\"ac\":" + ac + ",\"battery\":" + B(battery) +
      ",\"percent\":" + percent + ",\"lidPresent\":" + B(caps[2] != 0) + ",\"s3\":" + B(caps[5] != 0) + ",\"hiberFile\":" + B(caps[8] != 0) +
      ",\"aoac\":" + B(caps[20] != 0) + (error == null ? "" : ",\"error\":\"" + error.Replace("\\", "/").Replace("\"", "'") + "\"") + "}";
  }

  public static int Run() {
    if (!GetPwrCapabilities(caps)) caps = new byte[256];
    Thread t = new Thread(HoldLoop);
    t.IsBackground = true;
    t.Start();
    string lidError = WatchLid();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      line = line.Trim();
      string error = null;
      bool suspend = false;
      if (line == "hold") SetHold(true);
      else if (line == "release") SetHold(false);
      else if (line == "sleep" || line == "hibernate") { error = EnableShutdownPrivilege(); suspend = error == null; }
      else if (line == "status") error = lidError;
      else error = "unknown command";
      Console.Out.WriteLine(Status(error));
      Console.Out.Flush();
      // Answer first: SetSuspendState returns only after the machine wakes up again.
      if (suspend) SetSuspendState(line == "hibernate", false, false);
    }
    return 0;
  }
}
`;

/** The child's whole program, for `-EncodedCommand` (no quoting of any kind reaches a shell). */
export function helperScript(): string {
  return ["$ErrorActionPreference = 'Stop'", "Add-Type -IgnoreWarnings -TypeDefinition @'", HELPER_CS.trim(), "'@", "exit ([ClaudeRippleAwake]::Run())", ""].join("\n");
}

export type HelperCommand = "status" | "hold" | "release" | "sleep" | "hibernate";
export type HelperReply = {
  ok: boolean;
  held: boolean;
  lid: "open" | "closed" | null;
  ac: boolean | null;
  battery: boolean;
  percent: number | null;
  lidPresent: boolean;
  s3: boolean;
  hiberFile: boolean;
  aoac: boolean;
  error?: string;
};

export function parseHelperReply(line: string): HelperReply | null {
  try {
    const j = JSON.parse(line) as Partial<HelperReply>;
    if (typeof j.ok !== "boolean" || typeof j.held !== "boolean") return null;
    return {
      ok: j.ok,
      held: j.held,
      lid: j.lid === "open" || j.lid === "closed" ? j.lid : null,
      ac: typeof j.ac === "boolean" ? j.ac : null,
      battery: j.battery === true,
      percent: typeof j.percent === "number" ? j.percent : null,
      lidPresent: j.lidPresent === true,
      s3: j.s3 === true,
      hiberFile: j.hiberFile === true,
      aoac: j.aoac === true,
      ...(typeof j.error === "string" ? { error: j.error } : {}),
    };
  } catch {
    return null;
  }
}

/** The battery as decideAwake reads it. No battery: percent null, never "on battery". */
export function helperBattery(r: HelperReply): Battery {
  return { percent: r.battery ? r.percent : null, onBattery: r.battery && r.ac === false };
}

export interface ExecStateHelper {
  send(cmd: HelperCommand): Promise<HelperReply>;
  /** Close stdin (the child exits on its own); kill it if it has not gone in a few seconds. */
  close(): void;
  readonly alive: boolean;
}

/** Spawns the child. Returns its stdio as a Node child process does. */
export type HelperSpawn = () => ChildProcessWithoutNullStreams;

export const defaultHelperSpawn: HelperSpawn = () =>
  nodeSpawn(POWERSHELL, psArgs(helperScript()), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: powershellEnv() });

/** Add-Type compiles the C# on the first command: allow for a slow, cold csc. */
export const HELPER_FIRST_REPLY_MS = 60_000;
export const HELPER_REPLY_MS = 10_000;

/** One child, one command at a time, one line back per command. */
export class LineHelper implements ExecStateHelper {
  private readonly child: ReturnType<HelperSpawn>;
  private buffered = "";
  private stderr = "";
  private exited = false;
  private first = true;
  private waiting: { resolve: (r: HelperReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(spawn: HelperSpawn = defaultHelperSpawn) {
    this.child = spawn();
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    // A write to a child that died is reported here, not thrown.
    this.child.stdin.on("error", () => {});
    this.child.on("error", (e) => this.fail(new Error(`keep-awake helper: ${e.message}`)));
    this.child.on("exit", (code) => this.fail(new Error(`keep-awake helper exited (${code ?? "signal"})${this.stderr.trim() ? `: ${lastLine(this.stderr)}` : ""}`)));
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(cmd: HelperCommand): Promise<HelperReply> {
    const next = this.chain.then(() => this.exchange(cmd));
    this.chain = next.catch(() => {});
    return next;
  }

  close(): void {
    if (this.exited) return;
    this.child.stdin.end();
    setTimeout(() => {
      if (!this.exited) this.child.kill();
    }, 5_000).unref();
  }

  private exchange(cmd: HelperCommand): Promise<HelperReply> {
    if (this.exited) return Promise.reject(new Error(`keep-awake helper is not running${this.stderr.trim() ? `: ${lastLine(this.stderr)}` : ""}`));
    const ms = this.first ? HELPER_FIRST_REPLY_MS : HELPER_REPLY_MS;
    this.first = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error(`keep-awake helper did not answer "${cmd}" in ${ms / 1000}s`));
        this.child.kill();
      }, ms);
      timer.unref();
      this.waiting = { resolve, reject, timer };
      this.child.stdin.write(`${cmd}\n`);
    });
  }

  private onData(chunk: string): void {
    this.buffered += chunk;
    let nl: number;
    while ((nl = this.buffered.indexOf("\n")) >= 0) {
      const line = this.buffered.slice(0, nl).trim();
      this.buffered = this.buffered.slice(nl + 1);
      if (!line) continue;
      const w = this.waiting;
      if (!w) continue;
      this.waiting = null;
      clearTimeout(w.timer);
      const reply = parseHelperReply(line);
      if (reply) w.resolve(reply);
      else w.reject(new Error(`keep-awake helper said: ${line.slice(0, 200)}`));
    }
  }

  private fail(e: Error): void {
    this.exited = true;
    const w = this.waiting;
    this.waiting = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-1)[0]?.trim().slice(0, 200) ?? "";
}

// ---- Backend -------------------------------------------------------------------------------------

export type WinAwakeDeps = {
  run: Runner;
  helper?: () => ExecStateHelper;
  sleep: (ms: number) => Promise<void>;
  log: { info(m: string): void; warn(m: string): void };
  /** Writes the journal now (the controller's persist), so `lid` is on disk before powercfg changes it. */
  save: () => void;
  now?: () => number;
};

export const WIN_SLEEP_SETTLE_MS = 3_000;
export const HELPER_RETRY_MS = 60_000;

export class WinAwakeBackend implements AwakeBackend {
  private readonly deps: WinAwakeDeps;
  private helper: ExecStateHelper | null = null;
  /** The user's lid action, saved before we set "Do nothing"; null while we have not changed it. */
  private saved: LidAction | null = null;
  /** What release() put back, for the lid-closed sleep that follows it. */
  private restored: LidAction | null = null;
  /** The controller considers the machine held: keep the child holding (a crashed child is replaced). */
  private intent = false;
  private last: HelperReply | null = null;
  private helperFailure: { at: number; message: string } | null = null;

  constructor(deps: WinAwakeDeps, journal: AwakeJournal | null) {
    this.deps = deps;
    if (journal?.applied) {
      this.intent = true;
      this.saved = journal.lid ?? null;
    }
  }

  journalExtra(): Partial<AwakeJournal> {
    return this.saved ? { lid: this.saved } : {};
  }

  setup(): "ok" {
    return "ok";
  }

  private ensureHelper(): ExecStateHelper {
    if (this.helper?.alive) return this.helper;
    // A child that cannot start (Constrained Language Mode, a blocked Add-Type) is not respawned on
    // every 15s tick: once a minute, with the reason kept in the meantime.
    const now = (this.deps.now ?? Date.now)();
    if (this.helperFailure && now - this.helperFailure.at < HELPER_RETRY_MS) throw new Error(this.helperFailure.message);
    this.helper = (this.deps.helper ?? (() => new LineHelper()))();
    return this.helper;
  }

  private helperFailed(e: unknown): string {
    const message = (e as Error).message;
    this.helperFailure = { at: (this.deps.now ?? Date.now)(), message };
    this.closeHelper();
    return message;
  }

  private closeHelper(): void {
    this.helper?.close();
    this.helper = null;
  }

  async readGuards(needed: boolean): Promise<Guards> {
    // Nothing wants the PC awake and nothing of ours is held: no child at all.
    if (!needed && !this.intent) {
      this.closeHelper();
      this.last = null;
      return { battery: null, thermal: null, lidClosed: null };
    }
    try {
      const h = this.ensureHelper();
      let r = await h.send("status");
      // The child is per process: after a restart (or a crash) the hold has to be taken again.
      if (this.intent && !r.held) r = await h.send("hold");
      this.last = r;
      this.helperFailure = null;
      return { battery: helperBattery(r), thermal: "unknown", lidClosed: r.lid === null ? null : r.lid === "closed" };
    } catch (e) {
      return { battery: null, thermal: "unknown", lidClosed: null, error: this.helperFailed(e) };
    }
  }

  /** No second app writes Windows' idle-sleep hold or the plan's lid action, so no known writer is named here. */
  async probeConflict(): Promise<ConflictApp | null> {
    return null;
  }

  /**
   * While the journal says held: is the lid action still ours? A user who changed it (or switched
   * to another plan) has decided; their new values become the ones to restore if it is set again.
   */
  async stillHeld(): Promise<boolean> {
    if (!this.saved) return true;
    const { lid } = await readLidAction(this.deps.run);
    if (!lid) return true;
    if (lid.scheme === this.saved.scheme && lid.ac === LID_DO_NOTHING && lid.dc === LID_DO_NOTHING) return true;
    if (lid.scheme !== this.saved.scheme) {
      // Another plan is active now: the one we changed still says "Do nothing"; put it back.
      const err = await writeLidAction(this.deps.run, this.saved.scheme, this.saved.ac, this.saved.dc);
      if (err) this.deps.log.warn(`awake: could not restore the lid action of plan ${this.saved.scheme}: ${err}`);
    }
    this.deps.log.info("awake: the lid-close action was changed outside ClaudeRipple (or the power plan was switched)");
    this.saved = null;
    this.intent = false;
    this.closeHelper();
    return false;
  }

  async hold(): Promise<HoldOutcome> {
    let reply: HelperReply;
    try {
      reply = await this.ensureHelper().send("hold");
    } catch (e) {
      return { ok: false, refused: false, message: this.helperFailed(e) };
    }
    if (!reply.held) return { ok: false, refused: false, message: reply.error ?? "SetThreadExecutionState failed" };
    this.intent = true;
    if (!this.saved) {
      const { lid, error } = await readLidAction(this.deps.run);
      if (!lid) {
        // A desktop (no lid setting): holding off idle sleep is all there is to do.
        if (error && reply.lidPresent) this.deps.log.warn(`awake: cannot read the lid-close action: ${error}`);
        return { ok: true };
      }
      if (lid.ac === LID_DO_NOTHING && lid.dc === LID_DO_NOTHING) return { ok: true };
      this.saved = lid;
      this.deps.save();
    }
    const err = await writeLidAction(this.deps.run, this.saved.scheme, LID_DO_NOTHING, LID_DO_NOTHING);
    if (err) {
      // Put back whatever part was written; a policy-locked plan must not be left half changed.
      await writeLidAction(this.deps.run, this.saved.scheme, this.saved.ac, this.saved.dc);
      this.saved = null;
      this.intent = false;
      await this.helper?.send("release").catch(() => undefined);
      return { ok: false, refused: false, message: `Windows refused to change the lid-close action (Group Policy?): ${err}` };
    }
    return { ok: true };
  }

  async release(): Promise<HoldOutcome> {
    this.intent = false;
    if (this.helper?.alive) {
      try {
        this.last = await this.helper.send("release");
      } catch {
        this.closeHelper();
      }
    }
    this.restored = null;
    if (this.saved) {
      const err = await writeLidAction(this.deps.run, this.saved.scheme, this.saved.ac, this.saved.dc);
      if (err) {
        this.intent = true; // still ours: retried next tick, and by `clauderipple stop`
        return { ok: false, refused: false, message: `could not restore the lid-close action: ${err}` };
      }
      this.restored = this.saved;
      this.saved = null;
    }
    return { ok: true };
  }

  async afterRelease(): Promise<void> {
    const restored = this.restored;
    this.restored = null;
    try {
      if (!restored || !this.helper?.alive) return;
      await this.deps.sleep(WIN_SLEEP_SETTLE_MS);
      const r = await this.helper.send("status");
      if (r.lid !== "closed") return;
      const action = r.ac === false ? restored.dc : restored.ac;
      const say = (m: string) => this.deps.log.info(`awake: lid is closed; ${m}`);
      if (action === LID_SLEEP) {
        if (r.aoac || !r.s3) return say("Modern Standby PC: left to Windows' idle sleep timer (SetSuspendState is not defined there)");
        say("sleeping now, as closing the lid would");
        await this.helper.send("sleep");
      } else if (action === LID_HIBERNATE) {
        if (!r.hiberFile) return say("hibernation is off: left to Windows' idle sleep timer");
        say("hibernating now, as closing the lid would");
        await this.helper.send("hibernate");
      } else say(`your lid-close action is ${action === LID_DO_NOTHING ? "Do nothing" : "Shut down"}: nothing is done`);
    } catch (e) {
      this.deps.log.warn(`awake: lid-closed sleep failed: ${(e as Error).message}`);
    } finally {
      // Sleep was answered before it was called; closing stdin lets the child exit after the wake.
      this.closeHelper();
    }
  }

  shutdown(): void {
    this.closeHelper();
  }

  /** For status: the last reply (tests). */
  lastReply(): HelperReply | null {
    return this.last;
  }
}

/**
 * For `clauderipple stop|uninstall|awake off` with no router: put back the lid action the journal
 * saved. The execution state needs nothing — it died with the router's child.
 */
export async function restoreLidFromJournal(run: Runner, journal: AwakeJournal | null): Promise<"released" | "not-held" | "failed"> {
  if (!journal?.applied || !journal.lid) return "not-held";
  return (await writeLidAction(run, journal.lid.scheme, journal.lid.ac, journal.lid.dc)) ? "failed" : "released";
}
