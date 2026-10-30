// Launcher-only tests: no CLI subprocess, OS impersonation, or real PowerShell.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installLauncher, uninstallLauncher, macAppPath, desktopEntryPath, macLauncherScript, desktopEntry, windowsTrayLauncher, windowsTrayLauncherPath, windowsShortcutScript, windowsShortcutOwner } from "../src/launcher.ts";
import type { Runtime } from "../src/runtime.ts";
import { fileSymlinks } from "../../../test/capabilities.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-launcher-"));
const previous = process.env.CLAUDERIPPLE_LAUNCHER_DIR;
after(() => {
  if (previous === undefined) delete process.env.CLAUDERIPPLE_LAUNCHER_DIR;
  else process.env.CLAUDERIPPLE_LAUNCHER_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
let sequence = 0;
function context(windows = false) {
  const dir = path.join(root, String(++sequence));
  process.env.CLAUDERIPPLE_LAUNCHER_DIR = path.join(dir, "shared");
  const a = path.join(dir, windows || process.platform === "win32" ? "A 한글 ' 공백 홈" : "A 한글 ' 공백 \" 홈");
  const b = path.join(dir, "B");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b);
  const rt: Runtime = { node: "/same/node", cli: "/same/cli.js", env: {}, repo: dir, router: "", hookScript: "", modDir: "", trayMain: "", packaged: false };
  return { a, b, rt };
}
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      result[path.relative(dir, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  return result;
}
for (const platform of ["darwin", "linux"] as const) {
  test(`${platform}: A/B share runtime and filename but cannot replace or remove each other`, () => {
    const { a, b, rt } = context();
    const opts = { rt, home: a, platform, version: "1" };
    assert.equal(installLauncher(opts).ok, true);
    const before = snapshot(process.env.CLAUDERIPPLE_LAUNCHER_DIR!);
    for (const operation of [installLauncher, uninstallLauncher]) {
      const result = operation({ ...opts, home: b });
      assert.equal(result.ok, false);
      assert.match(result.detail, /another installation/);
      assert.deepEqual(result.paths, []);
      assert.deepEqual(snapshot(process.env.CLAUDERIPPLE_LAUNCHER_DIR!), before);
    }
    assert.equal(installLauncher({ ...opts, version: "2" }).ok, true);
    assert.equal(uninstallLauncher(opts).paths.length, 1);
    assert.equal(uninstallLauncher(opts).detail, "no launcher was installed");
  });
  test(`${platform}: exact legacy evidence, not id/marker alone`, () => {
    const { a, b, rt } = context();
    const opts = { rt, home: a, platform, version: "1" };
    installLauncher(opts);
    const file = platform === "darwin" ? path.join(macAppPath(), "Contents/MacOS/ClaudeRipple") : desktopEntryPath();
    const render = platform === "darwin" ? macLauncherScript : desktopEntry;
    const legacy = render(rt, a).split("\n").filter(line => !line.includes("ClaudeRipple-Launcher-Home=")).join("\n");
    fs.writeFileSync(file, legacy);
    assert.equal(installLauncher({ ...opts, home: b }).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), legacy);
    assert.equal(installLauncher(opts).ok, true);
    fs.writeFileSync(file, platform === "linux" ? "[Desktop Entry]\nX-ClaudeRipple-Launcher=1\nExec=other\n" : "#!/bin/sh\nexec other\n");
    const unknown = fs.readFileSync(file, "utf8");
    assert.equal(uninstallLauncher(opts).ok, false);
    assert.equal(installLauncher(opts).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), unknown);
  });
  // A linked home is the same installation where homes are POSIX paths, which `normalizeHome`
  // resolves. On a Windows host the simulated homes are Windows paths, compared as text.
  test(`${platform}: home symlink equivalence`, { skip: process.platform === "win32" || !fileSymlinks }, () => {
    const { a, b, rt } = context();
    const opts = { rt, home: a, platform, version: "1" };
    assert.equal(installLauncher(opts).ok, true);
    const alias = path.join(path.dirname(b), "alias");
    fs.symlinkSync(a, alias, "dir");
    assert.equal(installLauncher({ ...opts, home: alias }).ok, true);
  });
  test(`${platform}: broken symlink and inspection failure are not absence`, { skip: !fileSymlinks }, () => {
    const { a, rt } = context();
    const opts = { rt, home: a, platform, version: "1" };
    const target = platform === "darwin" ? macAppPath() : desktopEntryPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(root, "missing"), target);
    assert.equal(installLauncher(opts).ok, false);
    assert.equal(uninstallLauncher(opts).ok, false);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    fs.unlinkSync(target);
    fs.mkdirSync(target); // incomplete bundle or directory where a desktop file should be
    assert.equal(uninstallLauncher(opts).ok, false);
    assert.equal(installLauncher(opts).ok, false);
    assert.equal(fs.statSync(target).isDirectory(), true);
  });
}

type Shortcut = { path: string; exists: boolean; target: string; args: string; description: string };
function shortcut(home: string, file = "start.lnk"): Shortcut {
  return { path: file, exists: true, target: "C:\\Windows\\System32\\conhost.exe", args: `--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${home}/clauderipple-tray.ps1"`, description: "ClaudeRipple menu-bar app" };
}
function executor(rows: Shortcut[]) {
  const mutations: string[] = [];
  const queries: string[] = [];
  return { mutations, queries, run: (script: string) => {
    if (script.includes("ConvertTo-Json")) { queries.push(script); return JSON.stringify(rows); }
    mutations.push(script);
    return rows.map(row => row.path).join("\r\n");
  } };
}
test("Windows: preflight all shortcuts; one foreign or unknown means no writes anywhere", () => {
  const { a, b, rt } = context(true);
  const local = windowsTrayLauncherPath(a);
  fs.writeFileSync(local, windowsTrayLauncher(rt, a));
  const before = fs.readFileSync(local);
  for (const foreign of [shortcut(b, "desktop.lnk"), { ...shortcut(a, "desktop.lnk"), description: "unrelated" }, { ...shortcut(a, "desktop.lnk"), target: "C:\\other.exe" }]) {
    const fake = executor([shortcut(a), foreign]);
    for (const operation of [installLauncher, uninstallLauncher]) {
      assert.equal(operation({ rt, home: a, version: "1", platform: "win32", powershell: fake.run }).ok, false);
      assert.deepEqual(fs.readFileSync(local), before);
    }
    assert.equal(fake.mutations.length, 0);
  }
});
test("Windows: absence installs, ours upgrades/removes, and executor failures preserve local source", () => {
  const { a, rt } = context(true);
  const absent = executor(["start.lnk", "desktop.lnk"].map(file => ({ path: file, exists: false, target: "", args: "", description: "" })));
  const opts = { rt, home: a, version: "1", platform: "win32" as const };
  assert.equal(installLauncher({ ...opts, powershell: absent.run }).ok, true);
  const local = windowsTrayLauncherPath(a);
  const before = fs.readFileSync(local);
  for (const run of [() => { throw new Error("COM access denied"); }, () => "", () => "[]", (s: string) => { if (s.includes("ConvertTo-Json")) return JSON.stringify([shortcut(a), shortcut(a, "desktop.lnk")]); throw new Error("Shortcuts changed"); }]) {
    for (const operation of [installLauncher, uninstallLauncher]) {
      const result = operation({ ...opts, powershell: run });
      assert.equal(result.ok, false);
      assert.match(result.detail, /failed/);
      assert.deepEqual(fs.readFileSync(local), before);
    }
  }
  const ours = executor([shortcut(a), shortcut(a, "desktop.lnk")]);
  assert.equal(installLauncher({ ...opts, powershell: ours.run }).ok, true);
  assert.equal(uninstallLauncher({ ...opts, powershell: ours.run }).ok, true);
  assert.equal(fs.existsSync(local), false);
  assert.equal(ours.mutations.length, 2);
  assert.ok(ours.mutations.every(script => script.indexOf("Shortcuts changed") < script.indexOf("$s.Save()") || !script.includes("$s.Save()")));
});
test("Windows: path case and separators compare as Windows, not host OS", () => {
  for (const home of ["C:\\한글 O'Brien\\HOME", "c:/한글 O'Brien/home"]) {
    assert.equal(windowsShortcutOwner(shortcut(home), "c:/한글 O'Brien/home").state, "ours");
    assert.equal(windowsShortcutOwner(shortcut(home), "C:\\other").state, "other");
  }
});
test("Windows: foreign or unknown local script blocks even shortcut inspection", () => {
  const { a, b, rt } = context(true);
  const file = windowsTrayLauncherPath(a);
  for (const text of [windowsTrayLauncher(rt, b), "# manual script", windowsTrayLauncher(rt, a).replace(/Home=[^\r\n]+/, "Home=%%%")]) {
    fs.writeFileSync(file, text);
    const fake = executor([]);
    for (const operation of [installLauncher, uninstallLauncher]) {
      assert.equal(operation({ rt, home: a, version: "1", platform: "win32", powershell: fake.run }).ok, false);
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
    assert.equal(fake.queries.length, 0);
    assert.equal(fake.mutations.length, 0);
  }
});
test("macOS: linked icon cannot redirect replacement into another installation", { skip: !fileSymlinks }, () => {
  const { a, b, rt } = context();
  const opts = { rt, home: a, version: "1", platform: "darwin" as const };
  const icon = path.join(rt.repo, "packages/app/assets/icon.icns");
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.writeFileSync(icon, "our icon");
  assert.equal(installLauncher(opts).ok, true);
  const installed = path.join(macAppPath(), "Contents/Resources/icon.icns");
  fs.unlinkSync(installed);
  const other = path.join(b, "icon.icns");
  fs.writeFileSync(other, "foreign icon");
  fs.symlinkSync(other, installed);
  assert.equal(installLauncher(opts).ok, false);
  assert.equal(uninstallLauncher(opts).ok, false);
  assert.equal(fs.readFileSync(other, "utf8"), "foreign icon");
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), true);
});
test("Windows: exact legacy script is adopted; explicit shortcut marker must agree with target", () => {
  const { a, b, rt } = context(true);
  const file = windowsTrayLauncherPath(a);
  const script = windowsTrayLauncher(rt, a);
  fs.writeFileSync(file, script.replace(/# ClaudeRipple-Launcher-Home=[^\r\n]+\r\n/, ""));
  const fake = executor([shortcut(a), shortcut(a, "desktop.lnk")]);
  const result = installLauncher({ rt, home: a, version: "1", platform: "win32", powershell: fake.run });
  assert.equal(result.ok, true, result.detail);
  assert.equal(fs.readFileSync(file, "utf8"), script);
  const marker = (home: string) => windowsTrayLauncher(rt, home).replace(/^﻿# /, "").split("\r\n")[0]!;
  assert.equal(windowsShortcutOwner({ ...shortcut(a), description: marker(a) }, a).state, "ours");
  assert.equal(windowsShortcutOwner({ ...shortcut(a), description: marker(b) }, a).state, "other");
  assert.equal(windowsShortcutOwner({ ...shortcut(b), description: marker(a) }, a).state, "other");
});
test("Windows: generated boundary quotes paths and rechecks all rows before mutations", () => {
  const script = windowsShortcutScript("C:\\한글 O'Brien\\clauderipple-tray.ps1", "C:\\icon.ico", "C:\\shared", false, [shortcut("C:\\한글 O'Brien"), shortcut("C:\\한글 O'Brien", "desktop.lnk")]);
  assert.ok(script.includes("O''Brien"));
  assert.ok(script.includes("ReparsePoint"));
  assert.ok(script.includes("PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand"));
  assert.ok(script.indexOf("Shortcuts changed") < script.indexOf("$s.Save()"));
});

// 0.12.14 wrote the launcher without the installed-for marker, naming whatever runtime it was
// built with. An update moves the runtime, so byte-for-byte comparison alone left the installed
// app "unknown" and blocked install, uninstall and --purge (B22). The recorded home is the same
// evidence a service plist carries.
for (const platform of ["darwin", "linux"] as const) {
  test(`${platform}: a launcher from before the marker is adopted though its runtime path moved`, () => {
    const { a, b, rt } = context();
    const opts = { rt, home: a, platform, version: "1" };
    assert.equal(installLauncher(opts).ok, true);
    const file = platform === "darwin" ? path.join(macAppPath(), "Contents", "MacOS", "ClaudeRipple") : desktopEntryPath();
    const rendered = platform === "darwin" ? macLauncherScript(rt, a) : desktopEntry(rt, a);
    const moved = path.join(a, "runtime", "bin", "node");
    const legacy = rendered.split("\n").filter((line) => !line.includes("ClaudeRipple-Launcher-Home=")).join("\n").split(rt.node).join(moved);
    fs.writeFileSync(file, legacy);
    // Another installation still sees its own home in the script, not this one.
    assert.equal(installLauncher({ ...opts, home: b }).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), legacy);
    // The home it records is this one: adopt it and write the current script.
    assert.equal(installLauncher(opts).ok, true);
    assert.ok(fs.readFileSync(file, "utf8").includes("ClaudeRipple-Launcher-Home="));
    assert.equal(uninstallLauncher(opts).paths.length, 1);
  });
}
