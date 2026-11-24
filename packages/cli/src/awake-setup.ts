// `clauderipple awake setup [--ssid NAME] [--remove]` — the one privileged step behind lid-closed
// awake and hotspot failover (router: awake.ts, tether.ts).
//
// It installs /etc/sudoers.d/clauderipple, which lets this user run exactly these as root, without a
// password (the router only ever uses `sudo -n`, which fails rather than prompting):
//   /usr/bin/pmset -a disablesleep 0 | 1     hold a closed MacBook awake, and release it
//   /usr/bin/pmset sleepnow                  put a closed Mac to sleep when we release it
//   /usr/sbin/networksetup -setairportnetwork <wifi device> <hotspot name>   (only with a hotspot name)
// The grant is per user, not per app (Insomnia's README says the same of its own rule).
//
// The rule text is built here and written to a temp file by this (unprivileged) process; the one
// privileged step is a single `osascript … do shell script … with administrator privileges`, so the
// user types their password into macOS's own dialog. That script copies the file root-owned, checks
// its SHA-256 against what was built (nothing can swap it in between), checks it with `visudo -cf`,
// moves it into place, and checks the whole sudoers config again — removing ours if that fails, so a
// broken rule can never lock the user out of sudo. Only then does it clear Insomnia's privileged
// leftovers; the rest of Insomnia is removed unprivileged afterwards. Everything is built as data
// and unit-tested as text: no SSID ever reaches a shell (it is validated, then only written to the
// file), and every path in the script is single-quoted.
//
// Windows has no privileged step (docs/ARCHITECTURE.md §8, Windows): power plans carry one ACL that
// gives Authenticated Users read/write, and joining a saved Wi-Fi profile is a user action. `awake
// setup` there checks instead of installing: that this account may change the lid-close action (a
// write of the values already there — a Group Policy override refuses it), and with `--ssid` that the
// Wi-Fi adapter, the hotspot's saved profile and an automatic profile to come back to exist.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ssidProblem } from "../../router/src/config.ts";
import { PMSET, SUDO, SUDOERS_FILE, readJournal, type Runner } from "../../router/src/awake.ts";
import { POWERSHELL, powershellEnv, psArgs, readLidAction, restoreLidFromJournal, writeLidAction } from "../../router/src/awake-win.ts";
import { NETWORKSETUP, parseWifiDevice } from "../../router/src/tether.ts";
import { FIND_WIFI_PS, WIN_HINTS, autoProfiles, hotspotProfile, listWifiProfiles, parseAdapterName } from "../../router/src/tether-win.ts";

export const OSASCRIPT = "/usr/bin/osascript";
const STAGED = "/etc/sudoers.d/.clauderipple.new"; // sudo ignores names containing a dot
const INSOMNIA_SUDOERS = "/etc/sudoers.d/insomnia";
const INSOMNIA_LABEL = "com.insomnia.backstop";
const INSOMNIA_KEYCHAIN_SERVICE = "insomnia-hotspot";
/** Insomnia's CFBundleIdentifier (its Resources/Info.plist and install.sh BUNDLE_ID). Kong's API client is also "Insomnia.app", with a process also named Insomnia. */
const INSOMNIA_BUNDLE_ID = "com.kgarg.insomnia";
const PLUTIL = "/usr/bin/plutil";

/** POSIX single quotes: the only character that needs care inside them is the quote itself. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An AppleScript string literal. */
export function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function userProblem(user: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user) ? null : `unexpected user name "${user}"`;
}

/** The sudoers drop-in. Throws on anything that could not be written literally. */
export function sudoersRule(o: { user: string; wifiDevice?: string; ssid?: string }): string {
  const bad = userProblem(o.user);
  if (bad) throw new Error(bad);
  const commands = [`${PMSET} -a disablesleep 0`, `${PMSET} -a disablesleep 1`, `${PMSET} sleepnow`];
  if (o.ssid !== undefined) {
    const problem = ssidProblem(o.ssid);
    if (problem) throw new Error(problem);
    if (!o.wifiDevice || !/^en\d+$/.test(o.wifiDevice)) throw new Error(`unexpected Wi-Fi device "${o.wifiDevice ?? ""}"`);
    commands.push(`${NETWORKSETUP} -setairportnetwork ${o.wifiDevice} ${o.ssid}`);
  }
  return [
    "# ClaudeRipple: keep the Mac awake with the lid closed, and join the phone hotspot.",
    "# Installed by `clauderipple awake setup`; removed by `clauderipple awake setup --remove`.",
    `${o.user} ALL=(root) NOPASSWD: ${commands.join(", ")}`,
    "",
  ].join("\n");
}

function pathProblem(p: string): string | null {
  return /^\/[A-Za-z0-9/._-]+$/.test(p) ? null : `unexpected characters in path ${p}`;
}

/** The privileged shell script for install. One line, run by `do shell script` (/bin/sh). */
export function installScript(o: { tempFile: string; sha256: string; removeInsomnia: boolean }): string {
  const bad = pathProblem(o.tempFile);
  if (bad) throw new Error(bad);
  if (!/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error("bad sha256");
  const undoStaged = `{ /bin/rm -f ${shQuote(STAGED)}; exit 3; }`;
  const steps = [
    "set -e",
    `/usr/bin/install -m 0440 -o root -g wheel ${shQuote(o.tempFile)} ${shQuote(STAGED)}`,
    `[ "$(/usr/bin/shasum -a 256 ${shQuote(STAGED)} | /usr/bin/cut -c1-64)" = ${shQuote(o.sha256)} ] || ${undoStaged}`,
    `/usr/sbin/visudo -cf ${shQuote(STAGED)} || ${undoStaged}`,
    `/bin/mv -f ${shQuote(STAGED)} ${shQuote(SUDOERS_FILE)}`,
    `/usr/sbin/visudo -c || { /bin/rm -f ${shQuote(SUDOERS_FILE)}; exit 4; }`,
  ];
  // Insomnia's privileged leftovers, only after ours is safely in place: clear the sleep bit it may
  // have left set (its backstop is about to go), then its rule.
  if (o.removeInsomnia) steps.push(`${PMSET} -a disablesleep 0`, `/bin/rm -f ${shQuote(INSOMNIA_SUDOERS)}`);
  return steps.join("; ");
}

/** The privileged shell script for `--remove`. Clears the bit only if our journal says we set it. */
export function removeScript(o: { clearSleepBit: boolean }): string {
  const steps = ["set -e"];
  if (o.clearSleepBit) steps.push(`${PMSET} -a disablesleep 0`);
  steps.push(`/bin/rm -f ${shQuote(SUDOERS_FILE)} ${shQuote(STAGED)}`);
  return steps.join("; ");
}

/** `osascript` arguments that run `script` as root after macOS's own password dialog. */
export function adminOsascriptArgs(script: string, prompt: string): string[] {
  return ["-e", `do shell script ${asString(script)} with prompt ${asString(prompt)} with administrator privileges`];
}

export type CleanupStep =
  | { label: string; kind: "run"; file: string; args: string[] }
  | { label: string; kind: "trash"; path: string };

export function insomniaPaths(home: string): { plist: string; app: string } {
  return {
    plist: path.join(home, "Library", "LaunchAgents", `${INSOMNIA_LABEL}.plist`),
    app: path.join(home, "Applications", "Insomnia.app"),
  };
}

/**
 * Insomnia's unprivileged leftovers, in order. Failures are reported, not fatal. The app is quit
 * and trashed only when `insomniaApp` (~/Applications/Insomnia.app is that Insomnia, by bundle id).
 */
export function insomniaCleanupSteps(o: { uid: number; home: string; exists: (p: string) => boolean; insomniaApp: boolean }): CleanupStep[] {
  const p = insomniaPaths(o.home);
  const steps: CleanupStep[] = [{ label: "stop Insomnia's backstop agent", kind: "run", file: "/bin/launchctl", args: ["bootout", `gui/${o.uid}/${INSOMNIA_LABEL}`] }];
  if (o.exists(p.plist)) steps.push({ label: "move the backstop agent's plist to the Trash", kind: "trash", path: p.plist });
  if (o.insomniaApp) {
    steps.push({ label: "quit Insomnia", kind: "run", file: "/usr/bin/killall", args: ["-TERM", "Insomnia"] });
    steps.push({ label: "move Insomnia.app to the Trash", kind: "trash", path: p.app });
  }
  steps.push({ label: "delete Insomnia's hotspot password from the keychain", kind: "run", file: "/usr/bin/security", args: ["delete-generic-password", "-s", INSOMNIA_KEYCHAIN_SERVICE] });
  return steps;
}

export function insomniaPresent(home: string, exists: (p: string) => boolean, insomniaApp: boolean): boolean {
  return exists(INSOMNIA_SUDOERS) || exists(insomniaPaths(home).plist) || insomniaApp;
}

/** CFBundleIdentifier of ~/Applications/Insomnia.app: null when there is no such app, "" when it cannot be read. */
async function insomniaAppId(d: SetupDeps): Promise<string | null> {
  const app = insomniaPaths(d.home).app;
  if (!d.exists(app)) return null;
  const r = await d.run(PLUTIL, ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// ---- Orchestration ------------------------------------------------------------------------------

export type SetupDeps = {
  platform: NodeJS.Platform;
  run: Runner;
  user: string;
  uid: number;
  /** The user's home (for Insomnia's files). */
  home: string;
  /** ClaudeRipple's home (awake.json). */
  rippleHome: string;
  exists: (p: string) => boolean;
  /** Writes the rule to a fresh temp file and returns its path. */
  writeTemp: (content: string) => string;
  removeTemp: (file: string) => void;
  /** Moves a file to the Trash (fallback when /usr/bin/trash is missing or fails). */
  trashFallback: (p: string) => void;
  print: (line: string) => void;
};

export function defaultSetupDeps(run: Runner, rippleHome: string): SetupDeps {
  const info = os.userInfo();
  return {
    platform: process.platform,
    run,
    user: info.username,
    uid: info.uid,
    home: os.homedir(),
    rippleHome,
    exists: (p) => fs.existsSync(p),
    writeTemp: (content) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clauderipple-sudoers-"));
      const file = path.join(dir, "clauderipple");
      fs.writeFileSync(file, content, { mode: 0o644 });
      return file;
    },
    removeTemp: (file) => fs.rmSync(path.dirname(file), { recursive: true, force: true }),
    trashFallback: (p) => {
      const trash = path.join(os.homedir(), ".Trash");
      let target = path.join(trash, path.basename(p));
      if (fs.existsSync(target)) target = path.join(trash, `${path.basename(p, path.extname(p))} ${Date.now()}${path.extname(p)}`);
      fs.renameSync(p, target);
    },
    print: (line) => console.log(line),
  };
}

export type SetupResult = { ok: boolean; detail: string; wifiDevice?: string };

const LID_NAMES = ["Do nothing", "Sleep", "Hibernate", "Shut down"];

/** Windows: nothing to install; check what the router will need, and say what is missing. */
async function windowsSetup(o: { ssid?: string }, d: SetupDeps): Promise<SetupResult> {
  if (o.ssid !== undefined) {
    const problem = ssidProblem(o.ssid);
    if (problem) return { ok: false, detail: problem };
  }
  const { lid, error } = await readLidAction(d.run);
  if (lid) {
    // Writing back the values already there changes nothing and proves the write is allowed.
    const err = await writeLidAction(d.run, lid.scheme, lid.ac, lid.dc);
    if (err) return { ok: false, detail: `Windows does not let this account change the power plan's lid-close action (a Group Policy setting?): ${err}` };
    d.print(`✓ the lid-close action can be changed without administrator rights (now: plugged in ${LID_NAMES[lid.ac]}, on battery ${LID_NAMES[lid.dc]}); ClaudeRipple sets "Do nothing" only while it holds the PC awake, and puts these back`);
  } else d.print(`· this PC has no lid-close setting${error ? ` (${error})` : ""}: only idle sleep is held off`);
  let wifiDevice: string | undefined;
  if (o.ssid !== undefined) {
    const r = await d.run(POWERSHELL, psArgs(FIND_WIFI_PS), { env: powershellEnv(), timeoutMs: 20_000 });
    wifiDevice = (r.code === 0 ? parseAdapterName(r.stdout) : null) ?? undefined;
    if (!wifiDevice) return { ok: false, detail: "no Wi-Fi adapter found (Get-NetAdapter)" };
    const list = await listWifiProfiles(d.run);
    if (list.location) d.print(`· ${WIN_HINTS["needs-location"]}`);
    else if (list.error) d.print(`· could not list the saved Wi-Fi networks: ${list.error}`);
    else {
      const hotspot = hotspotProfile(list.profiles, o.ssid);
      d.print(hotspot ? `✓ Windows has joined "${o.ssid}" before (saved profile "${hotspot.name}")` : `· ${WIN_HINTS["no-hotspot-profile"]}`);
      const autos = autoProfiles(list.profiles, o.ssid);
      d.print(autos.length
        ? `✓ ${autos.length} other Wi-Fi network${autos.length === 1 ? "" : "s"} connect${autos.length === 1 ? "s" : ""} automatically, so ClaudeRipple can come back from the hotspot`
        : "· no other Wi-Fi on this PC is set to connect automatically, so ClaudeRipple would stay on the hotspot");
      if (hotspot?.auto) d.print(`· the hotspot's profile connects automatically too, so Windows may pick it over your Wi-Fi when coming back; \`netsh wlan set profileparameter name="${hotspot.name}" connectionmode=manual\` stops that (ClaudeRipple joins it by name either way)`);
    }
  }
  return { ok: true, detail: "setup complete (Windows needs no administrator step)", ...(wifiDevice ? { wifiDevice } : {}) };
}

export async function awakeSetup(o: { ssid?: string }, d: SetupDeps): Promise<SetupResult> {
  if (d.platform === "win32") return windowsSetup(o, d);
  if (d.platform !== "darwin") return { ok: false, detail: "lid-closed awake and hotspot failover are macOS and Windows only" };
  let wifiDevice: string | undefined;
  if (o.ssid !== undefined) {
    const problem = ssidProblem(o.ssid);
    if (problem) return { ok: false, detail: problem };
    const ports = await d.run(NETWORKSETUP, ["-listallhardwareports"]);
    wifiDevice = (ports.code === 0 ? parseWifiDevice(ports.stdout) : null) ?? undefined;
    if (!wifiDevice) return { ok: false, detail: "no Wi-Fi interface found (networksetup -listallhardwareports)" };
  }
  const rule = sudoersRule({ user: d.user, ...(o.ssid !== undefined ? { ssid: o.ssid, wifiDevice: wifiDevice! } : {}) });
  const appId = await insomniaAppId(d);
  const insomniaApp = appId === INSOMNIA_BUNDLE_ID;
  const removeInsomnia = insomniaPresent(d.home, d.exists, insomniaApp);
  const temp = d.writeTemp(rule);
  let r;
  try {
    const script = installScript({ tempFile: temp, sha256: crypto.createHash("sha256").update(rule).digest("hex"), removeInsomnia });
    d.print("macOS will ask for your password once, in its own dialog (ClaudeRipple never sees it).");
    r = await d.run(OSASCRIPT, adminOsascriptArgs(script, "ClaudeRipple wants to keep your Mac awake with the lid closed and join your phone hotspot when Wi-Fi fails."), { timeoutMs: 5 * 60_000 });
  } finally {
    d.removeTemp(temp);
  }
  if (r.code !== 0) {
    const text = (r.stderr || r.stdout).trim();
    return { ok: false, detail: /-128|cancel/i.test(text) ? "cancelled; nothing was changed" : `the privileged step failed: ${text.slice(0, 300)}` };
  }
  const check = await d.run(SUDO, ["-n", "-l", PMSET, "-a", "disablesleep", "1"]);
  if (check.code !== 0) return { ok: false, detail: "the rule was installed but `sudo -n -l` does not allow pmset; check /etc/sudoers.d/clauderipple" };
  d.print(`✓ installed ${SUDOERS_FILE}${o.ssid !== undefined ? ` (pmset, and joining "${o.ssid}" on ${wifiDevice})` : " (pmset)"}`);
  if (removeInsomnia) {
    d.print("✓ cleared Insomnia's sleep setting and its sudoers rule");
    for (const step of insomniaCleanupSteps({ uid: d.uid, home: d.home, exists: d.exists, insomniaApp })) d.print(`${(await runCleanupStep(step, d)) ? "✓" : "·"} ${step.label}`);
  }
  if (appId !== null && !insomniaApp) {
    d.print(`· left ${insomniaPaths(d.home).app} alone (neither quit nor trashed): its bundle id is ${appId || "unreadable"}, not ${INSOMNIA_BUNDLE_ID}, the keep-awake Insomnia`);
  }
  return { ok: true, detail: "setup complete", ...(wifiDevice ? { wifiDevice } : {}) };
}

async function runCleanupStep(step: CleanupStep, d: SetupDeps): Promise<boolean> {
  if (step.kind === "run") return (await d.run(step.file, step.args)).code === 0;
  const r = await d.run("/usr/bin/trash", [step.path]);
  if (r.code === 0) return true;
  try {
    d.trashFallback(step.path);
    return true;
  } catch {
    return false;
  }
}

export async function awakeRemove(d: SetupDeps): Promise<SetupResult> {
  if (d.platform === "win32") {
    // Nothing was installed; put back a lid action a router left changed.
    const r = await releaseAwake(d.run, d.rippleHome, "awake setup --remove", "win32");
    if (r === "failed") return { ok: false, detail: `could not restore the lid-close action: ${releaseFailedHint("win32")}` };
    return { ok: true, detail: `nothing to remove on Windows${r === "released" ? "; the lid-close action is back to yours" : ""}` };
  }
  if (d.platform !== "darwin") return { ok: false, detail: "lid-closed awake is macOS and Windows only" };
  const journal = readJournal(path.join(d.rippleHome, "awake.json"));
  const script = removeScript({ clearSleepBit: journal?.applied === true });
  d.print("macOS will ask for your password once, in its own dialog.");
  const r = await d.run(OSASCRIPT, adminOsascriptArgs(script, "ClaudeRipple wants to remove its lid-closed awake permission."), { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) {
    const text = (r.stderr || r.stdout).trim();
    return { ok: false, detail: /-128|cancel/i.test(text) ? "cancelled; nothing was changed" : `the privileged step failed: ${text.slice(0, 300)}` };
  }
  if (journal?.applied) writeReleasedJournal(d.rippleHome, "awake setup --remove");
  return { ok: true, detail: `removed ${SUDOERS_FILE}` };
}

function writeReleasedJournal(rippleHome: string, reason: string): void {
  const file = path.join(rippleHome, "awake.json");
  const prev = readJournal(file);
  fs.writeFileSync(file, JSON.stringify({ applied: false, since: new Date().toISOString(), reason, ...(prev?.lastActivityAt !== undefined ? { lastActivityAt: prev.lastActivityAt } : {}) }) + "\n", { mode: 0o600 });
}

/** What to tell a user whose machine could not be released. */
export function releaseFailedHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "set it back in Control Panel → Power Options → Choose what closing the lid does"
    : "run `sudo pmset -a disablesleep 0`";
}

/**
 * Uninstall clears the sleep bit but cannot silently take back the sudoers grant: removing a file
 * under /etc/sudoers.d needs an administrator, and an unattended prompt during uninstall is not one
 * (D2, 2026-10-25). `awake setup --remove` is the explicit, password-prompting path; this only says
 * the grant is still there and names the command. Pure, so it can be checked without touching sudo.
 */
export function remainingAwakeGrantHint(opts: { platform?: NodeJS.Platform; exists?: (file: string) => boolean } = {}): string | null {
  if ((opts.platform ?? process.platform) !== "darwin") return null;
  if (!(opts.exists ?? fs.existsSync)(SUDOERS_FILE)) return null;
  return `덮개를 닫아도 시스템이 잠자기에 들어가지 않게 하는 관리자 권한 규칙이 남아 있습니다. 더 이상 필요하지 않다면 \`sudo rm ${SUDOERS_FILE}\`을 직접 실행해 주세요. (또는 \`clauderipple awake setup --remove\`)`;
}

/**
 * If the router set the sleep bit (journal), clear it now with `sudo -n`; on Windows, put back the
 * lid-close action it saved (the execution state died with the router's child). For `stop`,
 * `uninstall` and `awake off` with no router answering: a router that is gone cannot reconcile it.
 */
export async function releaseAwake(run: Runner, rippleHome: string, reason: string, platform: NodeJS.Platform = process.platform): Promise<"released" | "not-held" | "failed"> {
  if (platform === "win32") {
    const journal = readJournal(path.join(rippleHome, "awake.json"));
    const r = await restoreLidFromJournal(run, journal);
    if (r === "failed") return r;
    if (journal?.applied) writeReleasedJournal(rippleHome, reason);
    return r;
  }
  if (platform !== "darwin") return "not-held";
  const journal = readJournal(path.join(rippleHome, "awake.json"));
  if (!journal?.applied) return "not-held";
  const r = await run(SUDO, ["-n", PMSET, "-a", "disablesleep", "0"]);
  if (r.code !== 0) return "failed";
  writeReleasedJournal(rippleHome, reason);
  return "released";
}
