import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adminOsascriptArgs, asString, awakeRemove, awakeSetup, insomniaCleanupSteps, installScript, releaseAwake, remainingAwakeGrantHint, removeScript, shQuote, sudoersRule,
  type SetupDeps,
} from "../src/awake-setup.ts";
import { readJournal, type RunResult } from "../../router/src/awake.ts";
import { needsPosixPaths, posixPaths } from "../../../test/capabilities.ts";

const PORTS = "Hardware Port: Ethernet Adapter (en3)\nDevice: en3\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: c0:c7:db:32:f6:de\n";

test("the sudoers rule names exact commands, the device and the hotspot", () => {
  assert.equal(
    sudoersRule({ user: "pbj", wifiDevice: "en0", ssid: "PBJ" }).split("\n")[2],
    "pbj ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow, /usr/sbin/networksetup -setairportnetwork en0 PBJ",
  );
  assert.equal(
    sudoersRule({ user: "pbj" }).split("\n")[2],
    "pbj ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow",
  );
  assert.match(sudoersRule({ user: "pbj", wifiDevice: "en1", ssid: "Name’s iPhone" }), /-setairportnetwork en1 Name’s iPhone$/m);
  assert.ok(sudoersRule({ user: "pbj" }).endsWith("\n"), "visudo wants a final newline");
  for (const ssid of ["PBJ, ALL", "a:b", "x=1", "*", "a\\b", "x\npbj ALL=(ALL) ALL"]) assert.throws(() => sudoersRule({ user: "pbj", wifiDevice: "en0", ssid }), JSON.stringify(ssid));
  assert.throws(() => sudoersRule({ user: "pbj ALL", wifiDevice: "en0" }));
  assert.throws(() => sudoersRule({ user: "pbj", wifiDevice: "en0; rm", ssid: "PBJ" }));
});

test("quoting: shell single quotes and AppleScript strings", () => {
  assert.equal(shQuote("/tmp/a b"), "'/tmp/a b'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(asString('say "hi" \\ bye'), '"say \\"hi\\" \\\\ bye"');
});

const SHA = "a".repeat(64);

test("install script: stage root-owned, check the hash, visudo it, move it, visudo everything, then Insomnia", () => {
  const s = installScript({ tempFile: "/var/folders/x/T/clauderipple-sudoers-ab/clauderipple", sha256: SHA, removeInsomnia: true });
  const order = [
    "set -e",
    "/usr/bin/install -m 0440 -o root -g wheel '/var/folders/x/T/clauderipple-sudoers-ab/clauderipple' '/etc/sudoers.d/.clauderipple.new'",
    `/usr/bin/shasum -a 256 '/etc/sudoers.d/.clauderipple.new'`,
    `= '${SHA}' ] || { /bin/rm -f '/etc/sudoers.d/.clauderipple.new'; exit 3; }`,
    "/usr/sbin/visudo -cf '/etc/sudoers.d/.clauderipple.new' || { /bin/rm -f '/etc/sudoers.d/.clauderipple.new'; exit 3; }",
    "/bin/mv -f '/etc/sudoers.d/.clauderipple.new' '/etc/sudoers.d/clauderipple'",
    "/usr/sbin/visudo -c || { /bin/rm -f '/etc/sudoers.d/clauderipple'; exit 4; }",
    "/usr/bin/pmset -a disablesleep 0",
    "/bin/rm -f '/etc/sudoers.d/insomnia'",
  ];
  let at = -1;
  for (const part of order) {
    const i = s.indexOf(part, at + 1);
    assert.ok(i > at, `"${part}" in order`);
    at = i;
  }
  assert.ok(!s.includes("\n"), "one line");
  const plain = installScript({ tempFile: "/tmp/x/clauderipple", sha256: SHA, removeInsomnia: false });
  assert.ok(!plain.includes("insomnia") && !plain.includes("disablesleep"));
  assert.throws(() => installScript({ tempFile: "/tmp/x'; rm -rf /; '", sha256: SHA, removeInsomnia: false }));
  assert.throws(() => installScript({ tempFile: "/tmp/x", sha256: "nothex", removeInsomnia: false }));
});

test("remove script clears the bit only when we set it", () => {
  assert.equal(removeScript({ clearSleepBit: true }), "set -e; /usr/bin/pmset -a disablesleep 0; /bin/rm -f '/etc/sudoers.d/clauderipple' '/etc/sudoers.d/.clauderipple.new'");
  assert.ok(!removeScript({ clearSleepBit: false }).includes("pmset"));
});

test("the osascript call is one admin do-shell-script with the script escaped", () => {
  const args = adminOsascriptArgs(`[ "$(x)" = 'y' ]`, "Why");
  assert.deepEqual(args, ["-e", `do shell script "[ \\"$(x)\\" = 'y' ]" with prompt "Why" with administrator privileges`]);
});

test("Insomnia cleanup: agent out, plist and app to the Trash, app quit, keychain item deleted — in that order", () => {
  const steps = insomniaCleanupSteps({ uid: 501, home: "/Users/pbj", exists: () => true, insomniaApp: true });
  if (posixPaths) {
    assert.deepEqual(steps.map((s) => (s.kind === "run" ? [s.file, ...s.args].join(" ") : `trash ${s.path}`)), [
      "/bin/launchctl bootout gui/501/com.insomnia.backstop",
      "trash /Users/pbj/Library/LaunchAgents/com.insomnia.backstop.plist",
      "/usr/bin/killall -TERM Insomnia",
      "trash /Users/pbj/Applications/Insomnia.app",
      "/usr/bin/security delete-generic-password -s insomnia-hotspot",
    ]);
  }
  assert.equal(insomniaCleanupSteps({ uid: 501, home: "/Users/pbj", exists: () => false, insomniaApp: false }).filter((s) => s.kind === "trash").length, 0);
});

test("Insomnia cleanup leaves another app named Insomnia running and in place", () => {
  const steps = insomniaCleanupSteps({ uid: 501, home: "/Users/pbj", exists: () => true, insomniaApp: false });
  assert.ok(!steps.some((s) => s.kind === "run" && s.file === "/usr/bin/killall"));
  assert.ok(!steps.some((s) => s.kind === "trash" && s.path.endsWith("Insomnia.app")));
});

// ---- Orchestration with a fake Mac --------------------------------------------------------------

function deps(o: { platform?: NodeJS.Platform; insomnia?: boolean; appId?: string; osascript?: RunResult; trashCli?: boolean } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const printed: string[] = [];
  const trashed: string[] = [];
  const temps = new Map<string, string>();
  const removed: string[] = [];
  const rippleHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-setup-"));
  const insomnia = new Set(o.insomnia ? ["/etc/sudoers.d/insomnia", "/Users/u/Library/LaunchAgents/com.insomnia.backstop.plist", "/Users/u/Applications/Insomnia.app"] : []);
  const d: SetupDeps = {
    platform: o.platform ?? "darwin",
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "/usr/sbin/networksetup") return { code: 0, stdout: PORTS, stderr: "" };
      if (file === "/usr/bin/osascript") return o.osascript ?? { code: 0, stdout: "", stderr: "" };
      if (file === "/usr/bin/plutil") return { code: 0, stdout: `${o.appId ?? "com.kgarg.insomnia"}\n`, stderr: "" };
      if (file === "/usr/bin/trash") return o.trashCli === false ? { code: -1, stdout: "", stderr: "ENOENT" } : { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    user: "u",
    uid: 501,
    home: "/Users/u",
    rippleHome,
    exists: (p) => insomnia.has(p),
    writeTemp: (content) => {
      const f = `/tmp/cr-test-${temps.size}/clauderipple`;
      temps.set(f, content);
      return f;
    },
    removeTemp: (f) => void removed.push(f),
    trashFallback: (p) => void trashed.push(p),
    print: (l) => void printed.push(l),
  };
  return { d, calls, printed, trashed, temps, removed, rippleHome };
}

test("setup: one privileged call with the rule's own hash, a sudo -n check, then Insomnia's unprivileged leftovers", { skip: needsPosixPaths }, async () => {
  const t = deps({ insomnia: true });
  const r = await awakeSetup({ ssid: "PBJ" }, t.d);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.wifiDevice, "en0");
  const files = t.calls.map((c) => c.file);
  assert.equal(files.filter((f) => f === "/usr/bin/osascript").length, 1, "exactly one password dialog");
  const [temp, rule] = [...t.temps][0]!;
  assert.match(rule, /-setairportnetwork en0 PBJ$/m);
  const script = t.calls.find((c) => c.file === "/usr/bin/osascript")!.args[1]!;
  assert.ok(script.includes(crypto.createHash("sha256").update(rule).digest("hex")), "the script checks the exact text written");
  assert.ok(script.includes(temp) && script.includes("with administrator privileges"));
  assert.deepEqual(t.removed, [temp], "the temp file is removed");
  const sudoCheck = files.indexOf("/usr/bin/sudo");
  assert.deepEqual(t.calls[sudoCheck]!.args, ["-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"]);
  assert.ok(files.indexOf("/usr/bin/plutil") < files.indexOf("/usr/bin/osascript"), "the app is identified before the dialog");
  const after = files.slice(sudoCheck + 1);
  assert.deepEqual(after, ["/bin/launchctl", "/usr/bin/trash", "/usr/bin/killall", "/usr/bin/trash", "/usr/bin/security"]);
});

test("setup with another app at ~/Applications/Insomnia.app neither quits nor trashes it, and says so", { skip: needsPosixPaths }, async () => {
  const t = deps({ insomnia: true, appId: "com.insomnia.app" });
  const app = path.join("/Users/u", "Applications", "Insomnia.app");
  assert.equal((await awakeSetup({}, t.d)).ok, true);
  assert.ok(!t.calls.some((c) => c.file === "/usr/bin/killall"));
  assert.ok(!t.calls.some((c) => c.file === "/usr/bin/trash" && c.args[0] === app));
  assert.ok(t.printed.some((l) => l.includes(`left ${app} alone`) && l.includes("com.insomnia.app")));
  // Insomnia's own leftovers (its sudoers rule, its backstop agent) are still cleared.
  assert.ok(t.calls.some((c) => c.file === "/bin/launchctl"));
});

test("setup without Insomnia touches nothing of it; /usr/bin/trash missing falls back to ~/.Trash", async () => {
  const t = deps();
  assert.equal((await awakeSetup({}, t.d)).ok, true);
  assert.ok(!t.calls.some((c) => c.file === "/bin/launchctl" || c.file === "/usr/bin/security"));
  assert.ok(!t.calls.find((c) => c.file === "/usr/bin/osascript")!.args[1]!.includes("insomnia"));
  if (posixPaths) {
    const u = deps({ insomnia: true, trashCli: false });
    assert.equal((await awakeSetup({}, u.d)).ok, true);
    assert.deepEqual(u.trashed, ["/Users/u/Library/LaunchAgents/com.insomnia.backstop.plist", "/Users/u/Applications/Insomnia.app"]);
  }
});

test("setup refuses before any prompt: another OS, a bad hotspot name; a cancelled dialog changes nothing", async () => {
  const linux = deps({ platform: "linux" });
  assert.equal((await awakeSetup({ ssid: "PBJ" }, linux.d)).ok, false);
  assert.deepEqual(linux.calls, []);
  const bad = deps();
  const r = await awakeSetup({ ssid: "PBJ, ALL" }, bad.d);
  assert.equal(r.ok, false);
  assert.deepEqual(bad.calls, []);
  const cancel = deps({ insomnia: true, osascript: { code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" } });
  const c = await awakeSetup({}, cancel.d);
  assert.equal(c.ok, false);
  assert.match(c.detail, /cancelled/);
  assert.ok(!cancel.calls.some((x) => x.file === "/bin/launchctl"), "Insomnia is left alone when ours did not install");
  assert.equal(cancel.removed.length, 1, "temp removed on failure too");
});

test("remove clears the bit only if our journal says we set it, then records it released", async () => {
  const t = deps();
  fs.writeFileSync(path.join(t.rippleHome, "awake.json"), JSON.stringify({ applied: true, since: "x", reason: "on", lastActivityAt: 5 }));
  assert.equal((await awakeRemove(t.d)).ok, true);
  assert.match(t.calls[0]!.args[1]!, /disablesleep 0/);
  assert.equal(readJournal(path.join(t.rippleHome, "awake.json"))?.applied, false);
  const u = deps();
  await awakeRemove(u.d);
  assert.doesNotMatch(u.calls[0]!.args[1]!, /pmset/);
});

test("releaseAwake (stop, uninstall, awake off with no router): sudo -n only when the journal says applied", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-release-"));
  const calls: string[] = [];
  const run = async (f: string, a: string[]): Promise<RunResult> => (calls.push([f, ...a].join(" ")), { code: 0, stdout: "", stderr: "" });
  assert.equal(await releaseAwake(run, home, "stop", "darwin"), "not-held");
  fs.writeFileSync(path.join(home, "awake.json"), JSON.stringify({ applied: true, since: "x", reason: "on" }));
  assert.equal(await releaseAwake(run, home, "stop", "linux"), "not-held");
  assert.deepEqual(calls, []);
  assert.equal(await releaseAwake(run, home, "stop", "darwin"), "released");
  assert.deepEqual(calls, ["/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"]);
  assert.equal(readJournal(path.join(home, "awake.json"))?.applied, false);
});

// Uninstall clears the sleep bit but cannot silently remove /etc/sudoers.d/clauderipple: that needs
// an administrator, and an unattended prompt is not an approval. The remaining grant is named with
// the command that revokes it (G-D02). Nothing here reads the real file: existence is injected.
test("an admin grant left behind is named with the command that removes it", () => {
  assert.equal(remainingAwakeGrantHint({ platform: "linux", exists: () => true }), null);
  assert.equal(remainingAwakeGrantHint({ platform: "win32", exists: () => true }), null);
  assert.equal(remainingAwakeGrantHint({ platform: "darwin", exists: () => false }), null);
  const hint = remainingAwakeGrantHint({ platform: "darwin", exists: (file) => file === "/etc/sudoers.d/clauderipple" });
  assert.ok(hint);
  assert.match(hint, /sudo rm \/etc\/sudoers\.d\/clauderipple/);
  assert.match(hint, /awake setup --remove/);
  assert.doesNotMatch(hint, /남아 있어요|저절로/);
});
