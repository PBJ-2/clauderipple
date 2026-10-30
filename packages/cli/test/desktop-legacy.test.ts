import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { applyAppProxy, configLibraryDir, currentAppProxy, migrateLegacyAppProxy, removeAppProxy } from "../src/picker.ts";
import { setPickerEnabled } from "../src/integrations.ts";
import { certPaths } from "../src/certs.ts";
import { directOn } from "../src/direct.ts";
import { applyProxyEnv, settingsEnv } from "../src/settings.ts";
import { ownersPath } from "../src/owners.ts";
import { removeClientIntegrations } from "../src/integrations.ts";
import { plistPath, renderPlist } from "../src/launchd.ts";
import { normalizeHome } from "../src/ownership.ts";

function fixture(t: { after(fn: () => void): void }) {
  // Native real path resolves macOS's /var link and Windows' 8.3 TEMP alias.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cr-desktop-legacy-")));
  const before = { ...process.env };
  const home = path.join(root, ".clauderipple");
  const other = path.join(root, "other");
  Object.assign(process.env, { HOME: root, USERPROFILE: root, CLAUDE_SETTINGS_PATH: path.join(root, "settings.json"), CLAUDE_APP_SUPPORT: path.join(root, "desktop"), CLAUDERIPPLE_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"), CODEX_HOME: path.join(root, "codex") });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port: 18791 } }));
  const url = "http://127.0.0.1:18791";
  fs.mkdirSync(configLibraryDir(), { recursive: true });
  fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ appliedId: "legacy", clauderipple: { ourId: "legacy", previousAppliedId: null } }));
  fs.writeFileSync(path.join(configLibraryDir(), "legacy.json"), JSON.stringify({ egressProxyUrl: url }));
  const service = (owner = home) => {
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), renderPlist({ home: owner, program: "/fake-node", stdoutLog: "/unused" }));
  };
  service();
  const deps = { platform: "darwin" as const, launchctl: (args: string[]) => { assert.equal(args[0], "print"); return { ok: true, out: "state = running\n pid = 4242\n" }; }, probe: () => ({ version: "0.12.14", home }), listenPids: () => [4242] };
  return { home, other, url, deps, service };
}

// Evaluate only the command body with injected external boundaries. Never import or execute the
// CLI entry point: its dispatch and native service/keychain dependencies must not run in tests.
function pickerOffCommand(f: ReturnType<typeof fixture>) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function pickerOff(): void {"), source.indexOf('\nimport { VERSION }'));
  const messages: string[] = [];
  let trustRemovals = 0;
  const run = () => vm.runInNewContext(stripTypeScriptTypes(`${body}\npickerOff();`), {
    homeDir: () => f.home,
    configPath: () => path.join(f.home, "config.json"),
    ConfigStore: class { get() { return { listen: { port: 18791 } }; } },
    proxyUrlFor: (port: number) => `http://127.0.0.1:${port}`,
    currentAppProxy, removeAppProxy,
    migrateLegacyAppProxy: (url: string, home: string) => migrateLegacyAppProxy(url, home, f.deps),
    setPickerEnabled: (enabled: boolean) => setPickerEnabled(enabled, path.join(f.home, "config.json")),
    certPaths, flag: () => false, isWindows: false, isLinux: false,
    untrustCa: () => { trustRemovals++; return "removed"; },
    console: { log: (message: string) => messages.push(message) },
  });
  return { run, messages, trustRemovals: () => trustRemovals };
}

test("picker off migrates a verified legacy Desktop entry before disabling picker and CA trust", t => {
  const f = fixture(t);
  const command = pickerOffCommand(f);
  command.run();
  assert.equal(currentAppProxy().egressProxyUrl, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, "config.json"), "utf8")).picker.enabled, false);
  assert.equal(command.trustRemovals(), 1);
  assert.equal(command.messages.some(message => message.includes("no ClaudeRipple config library entry")), false);
});

test("picker off preserves picker and CA trust when legacy Desktop ownership cannot be verified", t => {
  const f = fixture(t);
  f.service(f.other);
  const before = fs.readFileSync(path.join(f.home, "config.json"), "utf8");
  const command = pickerOffCommand(f);
  assert.throws(command.run, /설치 소유권을 확인하지 못해/);
  assert.equal(currentAppProxy().egressProxyUrl, f.url);
  assert.equal(fs.readFileSync(path.join(f.home, "config.json"), "utf8"), before);
  assert.equal(command.trustRemovals(), 0);
  assert.deepEqual(command.messages, []);
});

for (const reason of ["other-installation", "different-port"] as const) {
  test(`picker off preserves CA trust when proxy removal is refused for ${reason}`, t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ appliedId: "legacy", clauderipple: { ourId: "legacy", installationHome: reason === "other-installation" ? f.other : f.home } }));
    if (reason === "different-port") fs.writeFileSync(path.join(configLibraryDir(), "legacy.json"), JSON.stringify({ egressProxyUrl: "http://127.0.0.1:28791" }));
    const before = currentAppProxy();
    const config = fs.readFileSync(path.join(f.home, "config.json"), "utf8");
    const command = pickerOffCommand(f);
    assert.throws(command.run, /프록시가 제거되었는지 확인하지 못해/);
    assert.deepEqual(currentAppProxy(), before);
    assert.equal(fs.readFileSync(path.join(f.home, "config.json"), "utf8"), config);
    assert.equal(command.trustRemovals(), 0);
    assert.deepEqual(command.messages, []);
  });
}

test("legacy Desktop apply migrates only with the current home's definition and verified live PID", t => {
  const f = fixture(t);
  applyAppProxy(f.url, f.home, undefined, f.deps);
  assert.equal(currentAppProxy().installationHome, normalizeHome(f.home));
});

test("legacy Desktop uninstall completes for the default installation with independent evidence", t => {
  const f = fixture(t);
  assert.equal(removeClientIntegrations(f.home, () => "absent", { defaultHome: f.home, desktopService: f.deps }), true);
  assert.equal(currentAppProxy().egressProxyUrl, null);
});

test("migrated legacy Desktop evidence survives service removal before integration cleanup", t => {
  const f = fixture(t);
  applyAppProxy(f.url, f.home, undefined, f.deps);
  fs.unlinkSync(plistPath());
  assert.equal(removeClientIntegrations(f.home, () => "absent", { defaultHome: f.home, desktopService: { ...f.deps, launchctl: () => assert.fail("removed service must not be queried") } }), true);
  assert.equal(currentAppProxy().egressProxyUrl, null);
});

test("integration cleanup finishes a missing CA only after explicit manual trust removal confirmation", t => {
  const f = fixture(t);
  applyAppProxy(f.url, f.home, undefined, f.deps);
  assert.equal(removeClientIntegrations(f.home, undefined, { defaultHome: f.home }), false);
  assert.equal(fs.existsSync(path.join(f.home, "ca.pem")), false);
  assert.equal(removeClientIntegrations(f.home, undefined, { defaultHome: f.home, missingCaTrustRemoved: true }), true);
  fs.mkdirSync(path.join(f.home, "ca.pem"));
  assert.equal(removeClientIntegrations(f.home, undefined, { defaultHome: f.home, missingCaTrustRemoved: true }), false);
});

test("legacy Desktop direct on switches both clients with independent evidence", t => {
  const f = fixture(t);
  applyProxyEnv({ home: f.home, proxyUrl: f.url, caPath: path.join(f.home, "ca.pem"), force: false });
  const result = directOn(f.home, f.deps);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "direct");
  assert.equal(currentAppProxy().egressProxyUrl, null);
  assert.equal(settingsEnv().HTTPS_PROXY, undefined);
});

test("legacy Desktop direct on never reports success with an unproven proxy still applied", t => {
  const f = fixture(t);
  f.service(f.other);
  const result = directOn(f.home, f.deps);
  assert.equal(result.ok, false);
  assert.equal(currentAppProxy().egressProxyUrl, f.url);
});

for (const scenario of ["owners-store", "default-home", "damaged-owners-store"] as const) {
  test(`legacy Desktop cannot be adopted with ambiguous installation history: ${scenario}`, t => {
    const f = fixture(t);
    const home = scenario === "default-home" ? f.other : f.home;
    if (scenario === "default-home") {
      fs.mkdirSync(home);
      fs.copyFileSync(path.join(f.home, "config.json"), path.join(home, "config.json"));
      f.service(home);
      assert.equal(normalizeHome(path.join(os.homedir(), ".clauderipple")), normalizeHome(f.home));
    } else {
      fs.writeFileSync(ownersPath(process.env.CLAUDE_SETTINGS_PATH!), scenario === "damaged-owners-store" ? "{" : JSON.stringify({ version: 1, homes: { [f.home]: {}, [f.other]: {} } }));
    }
    const deps = { ...f.deps, probe: () => ({ version: "0.12.14", home }) };
    const meta = fs.readFileSync(path.join(configLibraryDir(), "_meta.json"), "utf8");
    const entry = fs.readFileSync(path.join(configLibraryDir(), "legacy.json"), "utf8");
    assert.throws(() => migrateLegacyAppProxy(f.url, home, deps), /어느 설치에서 설정했는지 확인할 수 없어/);
    assert.throws(() => applyAppProxy(f.url, home, undefined, deps), /어느 설치에서 설정했는지 확인할 수 없어/);
    assert.equal(fs.readFileSync(path.join(configLibraryDir(), "_meta.json"), "utf8"), meta);
    assert.equal(fs.readFileSync(path.join(configLibraryDir(), "legacy.json"), "utf8"), entry);
    const command = pickerOffCommand({ ...f, home, deps });
    assert.throws(command.run, /어느 설치에서 설정했는지 확인할 수 없어/);
    assert.equal(command.trustRemovals(), 0);
    assert.deepEqual(command.messages, []);
  });
}

for (const scenario of ["foreign-definition", "wrong-listener", "missing-pid", "lookup-failed", "generation-changed"] as const) {
  test(`legacy Desktop migration preserves the entry on ${scenario}`, t => {
    const f = fixture(t);
    if (scenario === "foreign-definition") f.service(f.other);
    const deps = {
      ...f.deps,
      listenPids: () => scenario === "wrong-listener" ? [9999] : [4242],
      launchctl: (args: string[]) => {
        assert.equal(args[0], "print");
        if (scenario === "generation-changed") f.service(f.other);
        return scenario === "lookup-failed" ? { ok: false, out: "permission denied" } : { ok: true, out: scenario === "missing-pid" ? "state = waiting" : "state = running\n pid = 4242\n" };
      },
    };
    const before = currentAppProxy();
    assert.throws(() => applyAppProxy(f.url, f.home, undefined, deps));
    assert.deepEqual(currentAppProxy(), before);
  });
}
