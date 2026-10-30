// Keep a laptop awake with its lid closed while Claude works: macOS here, Windows in awake-win.ts
// (the decision, journal and controller below are shared; each OS is an AwakeBackend).
//
// macOS: the only mechanism that holds a closed MacBook awake on battery or without an external display is
// `pmset -a disablesleep 1`, run as root. It is undocumented (absent from `man pmset`) but it is what
// every working open-source tool uses (Insomnia, MacMiniMode, Sleepless, Capsomnia, WiFiGuard), and
// `pmset -g` reports it as `SleepDisabled`. Root comes from a narrow sudoers rule installed once by
// `clauderipple awake setup`; here it is only ever `sudo -n`, which fails instead of prompting.
//
// Rules this module keeps (docs/ARCHITECTURE.md "Lid-closed awake and hotspot failover"):
//   - The bit is set only while it is wanted, and a journal (`<home>/awake.json`) records that we
//     set it, so a router that died with it set clears it on its next start.
//   - Battery below the floor, a thermal warning, or any error reading either forces it off.
//   - Turning it off with the lid closed sends the Mac to sleep, because clearing the bit alone leaves
//     a bagged Mac running (MacMiniMode does the same) — unless an external display is attached or
//     another process holds PreventSystemSleep. Only a guard release (battery, heat) overrides those.
//   - The router's exit does not touch the bit: a restart's successor reconciles within one tick,
//     and clearing it here then setting it again a second later is exactly the off-then-on window in
//     which a closed lid could sleep mid-work. `clauderipple stop`/`uninstall` clear it.
//   - Another app can write and clear the same bit: AlDente Pro's "Disable Sleep until Charge Limit"
//     is the known one (a table of preference reads, at most once a minute). A known writer, or a
//     clear we cannot attribute (kept 24 h, unless the Mac booted since the hold), is reported once
//     in the log, the CLI and the app — no re-assert wins against an immediate lid sleep.
//
// Every command goes through an injected `Runner`, never a shell, so tests run against fakes.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AwakeSettings } from "./config.ts";
import { WinAwakeBackend, type ExecStateHelper } from "./awake-win.ts";

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = {
  timeoutMs?: number;
  /**
   * Windows: hand `args` to the program exactly as written, joined by spaces. For netsh, whose
   * `name="My Hotspot"` must arrive with its own quotes; only ever used with values that were
   * checked to contain no quote.
   */
  verbatim?: boolean;
  /** Replaces the environment (Windows PowerShell needs PSModulePath removed, see powershellEnv). */
  env?: NodeJS.ProcessEnv;
};
/** Runs one program with arguments (no shell). Never throws: a spawn failure is code -1. */
export type Runner = (file: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const PMSET = "/usr/bin/pmset";
export const SUDO = "/usr/bin/sudo";
export const IOREG = "/usr/sbin/ioreg";
export const DEFAULTS = "/usr/bin/defaults";
export const SUDOERS_FILE = "/etc/sudoers.d/clauderipple";

/**
 * An app that also writes the global sleep setting we hold, and what to ask it. `app` is a stable id
 * (the laptop page looks up `mac.conflict.fix.<app>`), `name` what to show. Each entry is one
 * unprivileged `defaults read <domain> <key>`; a match is exit 0 and its stdout equal to `value`.
 * AlDente Pro's "Disable Sleep until Charge Limit" was measured on 2026-10-30: 1 while the option was
 * on, 0 after switching it to "Stop Charging when Sleeping". It writes the same bit as our
 * `pmset -a disablesleep` — set while charging, cleared when charging stops.
 */
export type SleepSettingWriter = { app: string; name: string; domain: string; key: string; value: string };
export const SLEEP_SETTING_WRITERS: readonly SleepSettingWriter[] = [
  { app: "aldente", name: "AlDente", domain: "com.apphousekitchen.aldente-pro", key: "completelyDisableSleep", value: "1" },
];

export function execRunner(): Runner {
  return (file, args, opts = {}) =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          timeout: opts.timeoutMs ?? 10_000,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          env: opts.env ?? { ...process.env, LC_ALL: "C" },
          windowsHide: true,
          ...(opts.verbatim ? { windowsVerbatimArguments: true } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, stdout, stderr });
          // A non-zero exit carries its status as a number; a spawn failure or timeout does not.
          const code = (error as { code?: unknown }).code;
          resolve({ code: typeof code === "number" ? code : -1, stdout: stdout ?? "", stderr: stderr || error.message });
        },
      );
    });
}

/** What the router is doing, from the proxy and ingress counters. */
export type Activity = { inFlight: number; lastStartedAt?: number; lastEndedAt?: number };

// ---- Parsers (outputs measured on macOS 27.0.1, 2026-10-20) ---------------------------------

export type Battery = { percent: number | null; onBattery: boolean };

/**
 * `pmset -g batt`:
 *   Now drawing from 'AC Power'
 *    -InternalBattery-0 (id=7995491)	55%; AC attached; not charging present: true
 * A Mac without a battery prints no InternalBattery line: percent null, never "on battery".
 */
export function parseBattery(text: string): Battery {
  const source = /Now drawing from '([^']+)'/.exec(text)?.[1] ?? "";
  const pct = /InternalBattery[^\n]*?\t?(\d{1,3})%/.exec(text)?.[1];
  return { percent: pct === undefined ? null : Number(pct), onBattery: /battery/i.test(source) };
}

export type Thermal = "normal" | "warning" | "unknown";

/**
 * `pmset -g therm`. Measured with nothing recorded:
 *   Note: No thermal warning level has been recorded
 * When a level is recorded pmset prints "Thermal warning level set to N." (any N > 0 is a warning).
 * Output that says neither is "unknown": reported, not acted on, because a wording change in a new
 * macOS must not switch the feature off for good. A failed command is an error, which is acted on.
 */
export function parseThermal(text: string): Thermal {
  const level = /thermal warning level set to (\d+)/i.exec(text)?.[1];
  if (level !== undefined) return Number(level) > 0 ? "warning" : "normal";
  if (/no thermal warning level has been recorded/i.test(text)) return "normal";
  return "unknown";
}

export type Clamshell = { lidClosed: boolean | null; causesSleep: boolean | null; sleepDisabled: boolean | null; darkWake: boolean | null };

/**
 * `ioreg -r -k AppleClamshellState -d 4` (no privilege needed):
 *   |   "System Capabilities" = 15
 *   |   "AppleClamshellCausesSleep" = No
 *   |   "AppleClamshellState" = Yes
 *   |   "SleepDisabled" = No
 * `AppleClamshellCausesSleep` is meant to be No while an external display keeps a closed Mac in
 * closed-display mode, but it is not enough alone: on 2026-10-26 it read Yes right after we cleared
 * the bit on a closed Mac driving an awake TV over HDMI, and sleepnow followed (see afterRelease).
 * `System Capabilities` is IOPM.h's kIOPMSystemCapability mask (CPU 1, Graphics 2, Audio 4, Network 8):
 * 15 in a full wake (measured 2026-10-24). A dark wake — the Mac up in the background while asleep to
 * its user — has no Graphics (`pmset -g log`: "DarkWake … [CDNP]" against a full "Wake … [CDNVA]").
 */
export function parseClamshell(text: string): Clamshell {
  const flag = (key: string): boolean | null => {
    const m = new RegExp(`"${key}"\\s*=\\s*(Yes|No)`).exec(text);
    return m ? m[1] === "Yes" : null;
  };
  const caps = /"System Capabilities"\s*=\s*(\d+)/.exec(text)?.[1];
  return {
    lidClosed: flag("AppleClamshellState"),
    causesSleep: flag("AppleClamshellCausesSleep"),
    sleepDisabled: flag("SleepDisabled"),
    darkWake: caps === undefined ? null : (Number(caps) & 2) === 0,
  };
}

/** A process that keeps the system out of sleep, from `pmset -g assertions`. */
export type SleepHolder = { pid: number; process: string; type: string; name: string };

/**
 * `pmset -g assertions`, the "Listed by owning process" lines (measured 2026-10-27/28):
 *   pid 1261(com.apphousekitchen.aldente-pro): [0x0001cf2f0007a5ad] 00:02:14 PreventSystemSleep named: "AlDente-Pro"
 *   pid 1200(Amphetamine): [0x0000108d0001904c] 15:58:34 PreventUserIdleSystemSleep named: "Amphetamine (Single-Use - System)"
 * Only PreventSystemSleep counts. The idle types (PreventUserIdleSystemSleep, NoIdleSleepAssertion —
 * Amphetamine, coreaudiod, the Claude app, powerd's "display is on") do not stop a closed lid from
 * sleeping: the Mac slept every lid close under the same Amphetamine session, and counting them kept
 * a closed Mac awake on battery from 05:33 to 09:19 on 2026-10-28 (§5).
 */
export function parseSleepHolders(text: string): SleepHolder[] {
  const holders: SleepHolder[] = [];
  for (const [, pid = "", proc = "", type = "", name = ""] of text.matchAll(/^\s*pid (\d+)\((.+?)\): \[[^\]]*\] \S+ (\w+) named: "(.*)"/gm)) {
    if (type === "PreventSystemSleep") holders.push({ pid: Number(pid), process: proc, type, name });
  }
  return holders;
}

/**
 * `ioreg -r -c IOMobileFramebufferShim -k DisplayAttributes -d 1` (no privilege needed): one block per
 * Apple silicon framebuffer with a display attached; unused ports have no DisplayAttributes. Measured
 * 2026-10-28 with the lid closed and two monitors attached, each block carrying
 *       "external" = Yes
 * while AppleClamshellCausesSleep read Yes, so this, not that flag, says whether a monitor or TV keeps
 * a closed Mac in closed-display mode. A Mac without these framebuffers (Intel) counts none.
 */
export function parseExternalDisplays(text: string): number {
  return text.match(/^\s*"external" = Yes$/gm)?.length ?? 0;
}

// ---- The decision -----------------------------------------------------------------------------

export const WORKING_GRACE_MS = 10 * 60_000;

export type AwakeInput = {
  settings: AwakeSettings;
  now: number;
  inFlight: number;
  /** Last time a model call started or finished, across router restarts (journal). */
  lastActivityAt?: number;
  battery: Battery | null;
  thermal: Thermal;
  /** macOS: the Mac is in a dark wake (see parseClamshell). */
  darkWake?: boolean;
  /** We hold the Mac awake now. */
  held?: boolean;
  /** A guard reading failed. */
  error?: string;
};

/**
 * Whether the Mac should be held awake now, and the one-line reason. Pure. `forced`: a guard (a failed
 * read, the battery floor, heat) turned it off although it is wanted.
 */
export function decideAwake(i: AwakeInput): { wanted: boolean; reason: string; forced?: true } {
  const { mode, until, batteryFloorPercent } = i.settings;
  if (mode === "off") return { wanted: false, reason: "off" };
  const untilMs = until ? Date.parse(until) : NaN;
  if (!Number.isNaN(untilMs) && i.now >= untilMs) return { wanted: false, reason: `until ${until} has passed` };
  let reason: string;
  if (mode === "on") reason = "on";
  else if (i.inFlight > 0) reason = `working: ${i.inFlight} model call${i.inFlight === 1 ? "" : "s"} running`;
  else if (i.lastActivityAt !== undefined && i.now - i.lastActivityAt < WORKING_GRACE_MS) reason = `working: last model call ${Math.round((i.now - i.lastActivityAt) / 1000)}s ago`;
  else return { wanted: false, reason: "idle: no model call in the last 10 min" };
  // A Mac that went to sleep runs calls in its maintenance wakes (cache keep-warm pings, a scheduled
  // task); holding it then kept a closed lid awake on battery for an hour (§5). Only work
  // begun while the Mac was awake to its user takes a hold; one already taken is kept.
  if (mode === "working" && i.darkWake && !i.held) return { wanted: false, reason: "asleep: a model call in a dark wake does not hold the Mac awake" };
  // Guards only matter when something wants the Mac awake.
  if (i.error) return { wanted: false, reason: `error: ${i.error}`, forced: true };
  if (i.battery?.onBattery && i.battery.percent !== null && i.battery.percent < batteryFloorPercent) {
    return { wanted: false, reason: `battery ${i.battery.percent}% is below ${batteryFloorPercent}%`, forced: true };
  }
  if (i.thermal === "warning") return { wanted: false, reason: "thermal warning", forced: true };
  return { wanted: true, reason };
}

// ---- Journal -----------------------------------------------------------------------------------

/** Windows: a power plan's lid-close action on AC and on battery (0 nothing, 1 sleep, 2 hibernate, 3 shut down). */
export type LidAction = { scheme: string; ac: number; dc: number };

/**
 * `applied`: macOS, we set the disablesleep bit; Windows, we hold the PC awake and (with `lid`) set the
 * lid-close action to "Do nothing" — `lid` is the user's own action, to put back.
 */
export type AwakeJournal = { applied: boolean; since: string; reason: string; lastActivityAt?: number; lid?: LidAction };

function journalLid(v: unknown): LidAction | undefined {
  const l = v as Partial<LidAction> | null | undefined;
  if (!l || typeof l.scheme !== "string" || !/^[0-9a-f-]{36}$/i.test(l.scheme)) return undefined;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 3;
  return ok(l.ac) && ok(l.dc) ? { scheme: l.scheme.toLowerCase(), ac: l.ac, dc: l.dc } : undefined;
}

export function readJournal(file: string): AwakeJournal | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AwakeJournal>;
    if (typeof j.applied !== "boolean") return null;
    const lid = journalLid(j.lid);
    return {
      applied: j.applied,
      since: String(j.since ?? ""),
      reason: String(j.reason ?? ""),
      ...(typeof j.lastActivityAt === "number" ? { lastActivityAt: j.lastActivityAt } : {}),
      ...(lid ? { lid } : {}),
    };
  } catch {
    return null;
  }
}

export function writeJournal(file: string, j: AwakeJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** `sudo -n` refused: the rule is missing or does not cover this exact command. */
export function sudoRefused(r: RunResult): boolean {
  return r.code !== 0 && /password is required|not allowed|sudoers|sorry, user|a terminal is required/i.test(r.stderr + r.stdout);
}

// ---- Controller --------------------------------------------------------------------------------

/** A known app that also writes the sleep setting we hold, as the probe names it (SLEEP_SETTING_WRITERS). */
export type ConflictApp = { app: string; name: string };

/**
 * Why a held sleep setting is not ours alone: a known app that also writes it (`app`/`name`), or a
 * clear we could not attribute (both null). `at` is when it was last seen — the last probe for a known
 * app, the last outside re-enable for an unknown cause.
 */
export type AwakeConflict = { app: string | null; name: string | null; at: string };

export type AwakeStatus = {
  mode: AwakeSettings["mode"];
  applied: boolean;
  reason: string;
  setup: "ok" | "needs-setup" | "unsupported";
  battery: Battery | null;
  thermal: Thermal | null;
  lidClosed: boolean | null;
  until: string | null;
  conflict: AwakeConflict | null;
};

export type Guards = { battery: Battery | null; thermal: Thermal | null; lidClosed: boolean | null; darkWake?: boolean; error?: string };
export type HoldOutcome = { ok: true } | { ok: false; refused: boolean; message: string };

/** What one OS does for the controller. Every method that runs a command goes through the Runner. */
export interface AwakeBackend {
  /** This tick's guard readings. `needed` is false when nothing wants the machine awake right now. */
  readGuards(needed: boolean): Promise<Guards>;
  /** While the journal says held: false when it was undone outside us (nothing of ours left to undo). */
  stillHeld(): Promise<boolean>;
  /**
   * Read-only: another app that also writes the sleep setting we use (macOS: the table
   * SLEEP_SETTING_WRITERS). The controller spaces the calls; never privileged.
   */
  probeConflict(): Promise<ConflictApp | null>;
  hold(): Promise<HoldOutcome>;
  release(): Promise<HoldOutcome>;
  /**
   * Right after a successful release: put a closed lid to sleep where the OS would have. `forced`: a
   * guard (battery, heat, a failed read) released it, so sleep is not left to other processes.
   */
  afterRelease(forced: boolean): Promise<void>;
  setup(sudoFailed: boolean): "ok" | "needs-setup";
  /** Fields the backend keeps in the journal (Windows: the lid action to restore). */
  journalExtra(): Partial<AwakeJournal>;
  shutdown(): void;
}

export type AwakeDeps = {
  platform: NodeJS.Platform;
  run: Runner;
  settings: () => AwakeSettings;
  activity: () => Activity;
  journalFile: string;
  log: { info(m: string): void; warn(m: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (file: string) => boolean;
  /** Schedules the periodic tick; returns a cancel. Tests pass a no-op. */
  schedule?: (fn: () => void, everyMs: number) => () => void;
  /** Windows: the execution-state child (tests pass a fake). */
  winHelper?: () => ExecStateHelper;
  /** Seconds since boot (macOS: a boot after the hold explains a cleared bit); tests pass a value. */
  uptime?: () => number;
};

export const AWAKE_TICK_MS = 15_000;
/** Pause between clearing the bit and reading whether a closed lid now causes sleep. */
export const SLEEPNOW_SETTLE_MS = 3_000;
/** How often the conflict probe may run: it is a `defaults` child process on every full tick otherwise. */
export const CONFLICT_PROBE_MS = 60_000;
/** How long a clear we could not attribute stays reported, counted from the last outside re-enable. */
export const CONFLICT_KEEP_MS = 24 * 60 * 60_000;

export class AwakeController {
  private applied = false;
  private reason = "not started";
  private battery: Battery | null = null;
  private thermal: Thermal | null = null;
  private lidClosed: boolean | null = null;
  /** The last probe's known writer and when it was seen; null when no table entry matched. */
  private knownConflict: ConflictApp | null = null;
  private knownAt: number | null = null;
  /** When the sleep setting was last cleared outside us with no known writer behind it (unknown cause). */
  private unknownAt: number | null = null;
  /** When the conflict probe last ran; null until the first full evaluation. */
  private conflictAt: number | null = null;
  /** The conflict kind the log last reported (an `app` id, "unknown", or null), so a change is logged once. */
  private conflictLoggedKind: string | null = null;
  /** The name in the last logged conflict, for the "no longer changes" line. */
  private conflictLoggedName: string | null = null;
  /** When this hold was set (journal `since`, or now when a released state is set again): a boot after it is a reboot. */
  private heldSince: number | null = null;
  private sudoFailed = false;
  private lastActivityAt: number | undefined;
  private journaledActivityAt: number | undefined;
  private busy: Promise<void> | null = null;
  private cancel: (() => void) | null = null;
  private lastLogged = "";
  private readonly deps: AwakeDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backend: AwakeBackend | null;

  constructor(deps: AwakeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const j = readJournal(deps.journalFile);
    // Reconcile starts from what the last process recorded: if it set the bit and died (or was
    // restarted), we own it now and the first tick keeps or clears it.
    if (j) {
      this.applied = j.applied;
      this.lastActivityAt = j.lastActivityAt;
      this.journaledActivityAt = j.lastActivityAt;
      const since = Date.parse(j.since);
      this.heldSince = Number.isNaN(since) ? null : since;
    }
    const log = deps.log;
    if (deps.platform === "darwin") {
      this.backend = new MacAwakeBackend({ run: deps.run, sleep: this.sleep, log, fileExists: deps.fileExists ?? ((f) => fs.existsSync(f)) });
    } else if (deps.platform === "win32") {
      this.backend = new WinAwakeBackend({ run: deps.run, sleep: this.sleep, now: this.now, log, save: () => this.persist(true), ...(deps.winHelper ? { helper: deps.winHelper } : {}) }, j);
    } else this.backend = null;
  }

  get supported(): boolean {
    return this.backend !== null;
  }

  /** First tick now (the reconcile), then every 15s. A no-op where unsupported. */
  async start(): Promise<void> {
    if (!this.supported) {
      this.reason = "unsupported on this platform";
      return;
    }
    await this.tick();
    const schedule = this.deps.schedule ?? ((fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref();
      return () => clearInterval(t);
    });
    this.cancel = schedule(() => void this.tick(), AWAKE_TICK_MS);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }

  status(): AwakeStatus {
    const s = this.deps.settings();
    return {
      mode: s.mode,
      applied: this.applied,
      reason: this.reason,
      setup: this.backend ? this.backend.setup(this.sudoFailed) : "unsupported",
      battery: this.battery,
      thermal: this.thermal,
      lidClosed: this.lidClosed,
      until: s.until ?? null,
      conflict: this.currentConflict(),
    };
  }

  /** One evaluation. Concurrent callers share the running one. */
  tick(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (!this.busy) this.busy = this.evaluate().finally(() => (this.busy = null));
    return this.busy;
  }

  /** A fresh evaluation after a settings change: one already running read the old settings. */
  async refresh(): Promise<void> {
    if (this.busy) await this.busy;
    // A refresh follows `awake setup` or a settings change: a sudo refusal from before the setup
    // must not keep saying "needs setup" while the mode is off and nothing calls pmset to retry.
    this.sudoFailed = false;
    await this.tick();
  }

  /**
   * The router is exiting. Only the journal is written (with the latest activity, so a successor
   * remembers the working window); the bit stays as it is. See the header comment for why.
   */
  beforeExit(): void {
    if (!this.supported) return;
    this.noteActivity();
    this.persist(true);
    // Windows: the execution-state child exits with stdin closed (it would with the process anyway);
    // the lid action stays as journaled for the successor, like the macOS bit.
    this.backend?.shutdown();
  }

  private noteActivity(): void {
    const a = this.deps.activity();
    const latest = Math.max(a.lastStartedAt ?? 0, a.lastEndedAt ?? 0, a.inFlight > 0 ? this.now() : 0);
    if (latest > 0 && (this.lastActivityAt === undefined || latest > this.lastActivityAt)) this.lastActivityAt = latest;
  }

  private persist(force = false): void {
    // The activity time is written at most once a minute: it only has to survive a restart.
    const stale = this.lastActivityAt !== undefined && (this.journaledActivityAt === undefined || this.lastActivityAt - this.journaledActivityAt >= 60_000);
    if (!force && !stale) return;
    try {
      const prev = readJournal(this.deps.journalFile);
      writeJournal(this.deps.journalFile, {
        applied: this.applied,
        since: prev && prev.applied === this.applied ? prev.since : new Date(this.now()).toISOString(),
        reason: this.reason,
        ...(this.lastActivityAt !== undefined ? { lastActivityAt: this.lastActivityAt } : {}),
        ...(this.backend?.journalExtra() ?? {}),
      });
      this.journaledActivityAt = this.lastActivityAt;
    } catch (e) {
      this.deps.log.warn(`awake: cannot write journal: ${(e as Error).message}`);
    }
  }

  private logOnce(line: string): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.deps.log.info(line);
  }

  private async evaluate(): Promise<void> {
    const settings = this.deps.settings();
    this.noteActivity();
    const activity = this.deps.activity();
    const backend = this.backend!;
    // Nothing to watch: no reads, no processes, unless a hold we took still has to be released.
    if (settings.mode === "off" && !this.applied) {
      this.reason = "off";
      this.battery = null;
      this.thermal = null;
      this.lidClosed = null;
      // Nothing of ours is held, so a conflict would be about a bit we are not setting: forget it
      // quietly, and let the first tick after the next turn-on report it again.
      this.knownConflict = null;
      this.knownAt = null;
      this.unknownAt = null;
      this.conflictAt = null;
      this.conflictLoggedKind = null;
      this.conflictLoggedName = null;
      backend.shutdown();
      this.persist();
      return;
    }
    const decide = (g?: Guards) =>
      decideAwake({
        settings,
        now: this.now(),
        inFlight: activity.inFlight,
        ...(this.lastActivityAt !== undefined ? { lastActivityAt: this.lastActivityAt } : {}),
        battery: g?.battery ?? null,
        thermal: g?.thermal ?? "unknown",
        ...(g?.darkWake ? { darkWake: true } : {}),
        held: this.applied,
        ...(g?.error ? { error: g.error } : {}),
      });
    // Whether anything wants the machine awake before the guards are read: a backend may skip
    // reads (on Windows, a whole child process) when nothing does.
    const guards = await backend.readGuards(decide().wanted);
    this.battery = guards.battery;
    this.thermal = guards.thermal;
    this.lidClosed = guards.lidClosed;
    // What we set reads as undone: a reboot (the macOS bit does not survive one), another tool
    // (Insomnia saw one reset it every 2s), or the user changing the Windows lid action. Take it as
    // not applied, so a wanted state is set again below — re-asserting at most once per tick — and an
    // unwanted one is not "cleared" twice.
    if (this.applied && !(await backend.stillHeld())) {
      // Asked fresh (past the cache) because the answer decides who is named in the line below.
      const reboot = this.bootedAfterHold();
      const known = await this.probeConflict(true);
      this.logOnce(known
        ? `awake: sleep was re-enabled outside ClaudeRipple (${known.name})`
        : reboot
          ? "awake: sleep was re-enabled outside ClaudeRipple (reboot)"
          : "awake: sleep was re-enabled outside ClaudeRipple (another app or a settings change)");
      // A known writer explains the clear, and a boot explains it away; only the rest is an unknown cause.
      if (known || reboot) this.unknownAt = null;
      else this.unknownAt = this.now();
      this.applied = false;
    }
    // The bit matters from here on (something wants it, or a hold is being released): check whether
    // another app writes it too.
    await this.probeConflict();
    this.logConflictChanges();
    const d = decide(guards);
    this.reason = d.reason;
    if (d.reason.startsWith("asleep:")) this.logOnce(`awake: ${d.reason}`);
    if (d.wanted && !this.applied) await this.set(true, d.reason);
    else if (!d.wanted && this.applied) {
      if (await this.set(false, d.reason)) await backend.afterRelease(d.forced === true);
    }
    this.persist();
  }

  /**
   * At most once a minute. `force`: after the wait for a re-enable outside us, where the answer
   * decides who did it. Returns the known writer the table matched, or null.
   */
  private async probeConflict(force = false): Promise<ConflictApp | null> {
    const now = this.now();
    if (!force && this.conflictAt !== null && now - this.conflictAt < CONFLICT_PROBE_MS) return this.knownConflict;
    this.knownConflict = await this.backend!.probeConflict();
    this.knownAt = this.knownConflict ? now : null;
    this.conflictAt = now;
    return this.knownConflict;
  }

  /** The conflict to report now: a known writer first, then an unknown cause kept CONFLICT_KEEP_MS. */
  private currentConflict(): AwakeConflict | null {
    if (this.knownConflict) {
      return { app: this.knownConflict.app, name: this.knownConflict.name, at: new Date(this.knownAt ?? this.now()).toISOString() };
    }
    if (this.unknownAt !== null && this.now() - this.unknownAt < CONFLICT_KEEP_MS) {
      return { app: null, name: null, at: new Date(this.unknownAt).toISOString() };
    }
    return null;
  }

  /** The log says each change once: a known writer turning up, then going. An unknown cause rides with its line. */
  private logConflictChanges(): void {
    const known = this.knownConflict;
    const kind = known ? known.app : this.currentConflict() ? "unknown" : null;
    if (kind === this.conflictLoggedKind) return;
    if (known) this.deps.log.info(`awake: ${known.name} also changes the sleep setting this feature holds; when it turns it back, a closed lid sleeps at once (see the laptop page for the fix)`);
    else if (this.conflictLoggedName !== null) this.deps.log.info(`awake: ${this.conflictLoggedName} no longer changes the sleep setting`);
    this.conflictLoggedKind = kind;
    this.conflictLoggedName = known ? known.name : null;
  }

  /**
   * macOS only: the sleep bit never survives a reboot, so a cleared bit is the boot's doing, not a
   * conflict, when the system booted after the hold was set. On Windows a cleared lid action is
   * always an outside change, with no such exception.
   */
  private bootedAfterHold(): boolean {
    if (this.deps.platform !== "darwin" || this.heldSince === null) return false;
    const uptime = this.deps.uptime ?? os.uptime;
    return this.now() - uptime() * 1000 > this.heldSince;
  }

  /** Hold or release. The journal is written before holding and after releasing. */
  private async set(on: boolean, reason: string): Promise<boolean> {
    const backend = this.backend!;
    if (on) {
      this.applied = true;
      this.persist(true);
    }
    const r = on ? await backend.hold() : await backend.release();
    if (!r.ok) {
      this.sudoFailed = r.refused;
      if (on) {
        this.applied = false;
        this.persist(true);
      }
      this.reason = r.refused ? "needs setup: run `clauderipple awake setup` once" : r.message;
      this.logOnce(`awake: could not ${on ? "disable" : "re-enable"} sleep (${reason}): ${this.reason}`);
      return false;
    }
    this.sudoFailed = false;
    this.applied = on;
    // When the setting was (re)set, for telling a reboot from another app's clear on a later tick.
    this.heldSince = on ? this.now() : null;
    this.persist(true);
    this.lastLogged = "";
    this.deps.log.info(`awake: sleep ${on ? "disabled" : "re-enabled"} (${reason})`);
    return true;
  }
}

// ---- macOS ---------------------------------------------------------------------------------------

type MacDeps = { run: Runner; sleep: (ms: number) => Promise<void>; log: { info(m: string): void; warn(m: string): void }; fileExists: (f: string) => boolean };

class MacAwakeBackend implements AwakeBackend {
  private readonly deps: MacDeps;
  private clamshell: Clamshell | null = null;

  constructor(deps: MacDeps) {
    this.deps = deps;
  }

  setup(sudoFailed: boolean): "ok" | "needs-setup" {
    return sudoFailed || !this.deps.fileExists(SUDOERS_FILE) ? "needs-setup" : "ok";
  }

  journalExtra(): Partial<AwakeJournal> {
    return {};
  }

  shutdown(): void {}

  async readGuards(): Promise<Guards> {
    let error: string | undefined;
    let battery: Battery | null = null;
    let thermal: Thermal | null = null;
    const batt = await this.deps.run(PMSET, ["-g", "batt"]);
    if (batt.code === 0) battery = parseBattery(batt.stdout);
    else error = `pmset -g batt failed (${batt.code})`;
    const therm = await this.deps.run(PMSET, ["-g", "therm"]);
    if (therm.code === 0) thermal = parseThermal(therm.stdout);
    else error ??= `pmset -g therm failed (${therm.code})`;
    this.clamshell = await this.readClamshell();
    return { battery, thermal, lidClosed: this.clamshell?.lidClosed ?? null, darkWake: this.clamshell?.darkWake === true, ...(error ? { error } : {}) };
  }

  async stillHeld(): Promise<boolean> {
    return this.clamshell?.sleepDisabled !== false;
  }

  /**
   * The first table entry whose preference matches (no privilege): with AlDente's "Disable Sleep
   * until Charge Limit" on, `completelyDisableSleep` is 1 and AlDente writes the same global bit we
   * do. A missing domain or key exits non-zero, and 0 means the option is off (measured 2026-10-30
   * after the owner switched to "Stop Charging when Sleeping"): both are no match.
   */
  async probeConflict(): Promise<ConflictApp | null> {
    for (const w of SLEEP_SETTING_WRITERS) {
      const r = await this.deps.run(DEFAULTS, ["read", w.domain, w.key]);
      if (r.code === 0 && r.stdout.trim() === w.value) return { app: w.app, name: w.name };
    }
    return null;
  }

  private async readClamshell(): Promise<Clamshell | null> {
    const r = await this.deps.run(IOREG, ["-r", "-k", "AppleClamshellState", "-d", "4"]);
    return r.code === 0 ? parseClamshell(r.stdout) : null;
  }

  /** `sudo -n pmset -a disablesleep 1|0`. */
  private async disableSleep(on: boolean): Promise<HoldOutcome> {
    const r = await this.deps.run(SUDO, ["-n", PMSET, "-a", "disablesleep", on ? "1" : "0"]);
    if (r.code === 0) return { ok: true };
    return { ok: false, refused: sudoRefused(r), message: `pmset failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
  }

  hold(): Promise<HoldOutcome> {
    return this.disableSleep(true);
  }

  release(): Promise<HoldOutcome> {
    return this.disableSleep(false);
  }

  /**
   * With the bit cleared, a Mac whose lid is shut keeps running: nothing re-evaluates the lid. If the
   * lid is closed and macOS says a closed lid now causes sleep (no external display holding it in
   * closed-display mode), put it to sleep so a bagged Mac does not run on. Tried unprivileged first,
   * then through the sudoers rule.
   *
   * It sleeps only where macOS would have on the lid closing, had we not held it. Not with an external
   * display attached: on 2026-10-26 the flag read Yes on a closed Mac driving a TV, and sleepnow
   * dropped an Amphetamine session's remote sessions and stopped audio playing at the desk (§5). Not
   * while another process holds PreventSystemSleep (see parseSleepHolders). A failed read leaves the
   * Mac to macOS too. A guard release (`forced`) sleeps regardless.
   */
  async afterRelease(forced: boolean): Promise<void> {
    await this.deps.sleep(SLEEPNOW_SETTLE_MS);
    const c = await this.readClamshell();
    if (!c?.lidClosed || c.causesSleep !== true) return;
    if (!forced) {
      const d = await this.deps.run(IOREG, ["-r", "-c", "IOMobileFramebufferShim", "-k", "DisplayAttributes", "-d", "1"]);
      if (d.code !== 0) {
        this.deps.log.warn(`awake: lid is closed, but ioreg failed reading displays (${d.code}); leaving sleep to macOS`);
        return;
      }
      const displays = parseExternalDisplays(d.stdout);
      if (displays > 0) {
        this.deps.log.info(`awake: lid is closed, but ${displays} external display${displays === 1 ? " is" : "s are"} attached; leaving sleep to macOS`);
        return;
      }
      const a = await this.deps.run(PMSET, ["-g", "assertions"]);
      if (a.code !== 0) {
        this.deps.log.warn(`awake: lid is closed, but pmset -g assertions failed (${a.code}); leaving sleep to macOS`);
        return;
      }
      const holders = [...new Set(parseSleepHolders(a.stdout).map((h) => h.process))];
      if (holders.length > 0) {
        this.deps.log.info(`awake: lid is closed, but other processes prevent system sleep (${holders.join(", ")}); leaving sleep to macOS`);
        return;
      }
    }
    this.deps.log.info(`awake: lid is closed; sleeping now (${forced ? "a guard released the hold" : "no external display or system-sleep hold"})`);
    const r = await this.deps.run(PMSET, ["sleepnow"]);
    if (r.code === 0) return;
    const s = await this.deps.run(SUDO, ["-n", PMSET, "sleepnow"]);
    if (s.code !== 0) this.deps.log.warn(`awake: pmset sleepnow failed: ${(s.stderr || s.stdout || r.stderr).trim().slice(0, 200)}`);
  }
}
