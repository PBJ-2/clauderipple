import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyAppProxy, assertDesktopPresent, caTrusted, claudeDesktopPresent, DESKTOP_ABSENT_MESSAGE, nssNickname, nssTrust, nssTrusted, nssUntrust, untrustCa } from "../src/picker.ts";
import { X509Certificate } from "node:crypto";
import { createCa } from "../../router/src/x509.ts";

const onWindows = process.platform === "win32";

test("missing CA requires explicit trust removal confirmation, unlike unreadable certificates", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ca-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, "missing.pem");
  const malformed = path.join(root, "malformed.pem");
  fs.writeFileSync(malformed, "not a certificate");
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const run = () => assert.fail("must not query or delete certificates without identity");
    assert.equal(untrustCa(missing, { platform, run }), "missing");
    assert.equal(untrustCa(missing, { platform, run, missingCaTrustRemoved: true }), "absent");
    assert.equal(untrustCa(root, { platform, run, missingCaTrustRemoved: true }), "failed");
    assert.equal(untrustCa(malformed, { platform, run, missingCaTrustRemoved: true }), "failed");
  }
});

for (const code of ["EACCES", "EIO"]) {
  test(`CA recovery confirmation never bypasses ${code}`, t => {
    t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error(code), { code }); });
    assert.equal(untrustCa("/isolated/ca.pem", { missingCaTrustRemoved: true, run: () => assert.fail("store must not be touched") }), "failed");
  });
}

test("an unreadable CA fingerprint is a failed removal, never confirmed absence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ca-unreadable-"));
  try {
    assert.equal(untrustCa(path.join(root, "missing.pem")), "missing");
    assert.equal(untrustCa(root), "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS and Windows trust checks reject an old CA with the same subject", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ca-identity-"));
  const file = path.join(root, "ca.pem");
  const old = new X509Certificate(createCa({ cn: "ClaudeRipple local CA" }).certPem).fingerprint.replace(/:/g, "");
  const current = createCa({ cn: "ClaudeRipple local CA" }).certPem;
  const fingerprint = new X509Certificate(current).fingerprint.replace(/:/g, "");
  fs.writeFileSync(file, current);
  try {
    for (const platform of ["darwin", "win32"] as const) {
      let trusted = old;
      let verified = false;
      let verificationAllowed = true;
      let held = fingerprint;
      const run = (_command: string, args: string[]): string => {
        if (platform === "win32") return args.join(" ").includes(`Thumbprint -eq '${trusted}'`) ? "1" : "0";
        if (args[0] === "trust-settings-export") return `<plist><dict><key>trustList</key><dict><key>${trusted}</key><dict/></dict></dict></plist>`;
        if (args[0] === "find-certificate") {
          assert.deepEqual(args.slice(0, 5), ["find-certificate", "-a", "-Z", "-c", "ClaudeRipple local CA"]);
          return held ? `SHA-256 hash: 00\nSHA-1 hash: ${held}\nkeychain: "login.keychain-db"\n` : "";
        }
        assert.deepEqual(args.slice(0, 3), ["verify-cert", "-c", file]);
        verified = true;
        if (!verificationAllowed) throw new Error("not trusted");
        return "";
      };
      assert.equal(caTrusted(file, { platform, run }), false, platform);
      trusted = fingerprint;
      assert.equal(caTrusted(file, { platform, run }), true, platform);
      if (platform === "darwin") {
        assert.equal(verified, true, "trust, not mere presence, is verified");
        verificationAllowed = false;
        assert.equal(caTrusted(file, { platform, run }), false, "a matching but untrusted certificate is refused");
        // 2026-10-25: the certificate was gone from the keychain, its trust settings and the file
        // still verified, and `picker on` skipped adding it.
        verificationAllowed = true;
        held = "";
        assert.equal(caTrusted(file, { platform, run }), false, "trust settings without the certificate in the keychain are not trust");
        held = old;
        assert.equal(caTrusted(file, { platform, run }), false, "another certificate of the same name is not this one");
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function realCertutil(): boolean {
  try {
    execFileSync("certutil", ["-H"], { stdio: "ignore" });
    return true;
  } catch (e) {
    // certutil -H prints usage and exits non-zero; only a missing binary is ENOENT.
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// An NSS database reduced to what picker mode uses: one JSON file of nickname → {pem, trust}.
const FAKE_CERTUTIL = `const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CR_TEST_CALLS, JSON.stringify(args) + "\\n");
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const dir = opt("-d").replace(/^sql:/, "");
const db = path.join(dir, "cert9.db");
if (args.includes("-N")) { fs.writeFileSync(db, "{}"); process.exit(0); }
if (!fs.existsSync(db)) { process.stderr.write("certutil: function failed: SEC_ERROR_BAD_DATABASE\\n"); process.exit(255); }
const certs = JSON.parse(fs.readFileSync(db, "utf8"));
const save = () => fs.writeFileSync(db, JSON.stringify(certs));
const name = opt("-n");
if (args.includes("-A")) { certs[name] = { pem: fs.readFileSync(opt("-i"), "utf8"), trust: opt("-t") }; save(); process.exit(0); }
if (args.includes("-D")) { if (!certs[name]) process.exit(255); delete certs[name]; save(); process.exit(0); }
if (args.includes("-V")) process.exit(certs[name] && certs[name].trust.startsWith("C") ? 0 : 255);
if (args.includes("-L") && name) { if (!certs[name]) process.exit(255); process.stdout.write(certs[name].pem); process.exit(0); }
if (args.includes("-L")) {
  console.log("\\nCertificate Nickname                                         Trust Attributes\\n                                                             SSL,S/MIME,JAR/XPI\\n");
  for (const [n, c] of Object.entries(certs)) console.log(n.padEnd(60) + " " + c.trust);
  process.exit(0);
}
process.exit(1);
`;

/** Runs `fn` against a scratch NSS database, with `script` as the only certutil on PATH (none when null). */
async function withNss(script: string | null, fn: (ctx: { root: string; calls: () => string[][]; ca: (name: string) => string }) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-nss-"));
  const keys = ["CLAUDERIPPLE_NSS_DB", "PATH", "CR_TEST_CALLS"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  if (script) fs.writeFileSync(path.join(bin, "certutil"), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  process.env.CLAUDERIPPLE_NSS_DB = path.join(root, "nssdb");
  process.env.CR_TEST_CALLS = path.join(root, "calls.jsonl");
  // No certutil: nothing but our empty bin directory on PATH.
  process.env.PATH = script === null ? bin : `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  try {
    const calls = () =>
      fs.existsSync(process.env.CR_TEST_CALLS!)
        ? fs.readFileSync(process.env.CR_TEST_CALLS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])
        : [];
    const ca = (name: string) => {
      const file = path.join(root, `${name}.pem`);
      fs.writeFileSync(file, createCa({ cn: "ClaudeRipple local CA" }).certPem);
      return file;
    };
    await fn({ root, calls, ca });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Linux trust creates the NSS database if needed and adds the CA for TLS, once", { skip: onWindows }, () =>
  withNss(FAKE_CERTUTIL, ({ calls, ca }) => {
    const pem = ca("current");
    assert.equal(nssTrusted(pem), false);
    nssTrust(pem);
    assert.equal(nssTrusted(pem), true);
    nssTrust(pem);
    const adds = calls().filter((a) => a.includes("-A"));
    assert.equal(adds.length, 1, "trusting again adds nothing");
    assert.deepEqual(adds[0]!.slice(adds[0]!.indexOf("-A")), ["-A", "-n", nssNickname(pem), "-t", "C,,", "-i", pem]);
    assert.ok(calls().some((a) => a.includes("-N") && a.includes("--empty-password")), "database created without a password");
    assert.equal(fs.statSync(process.env.CLAUDERIPPLE_NSS_DB!).mode & 0o777, 0o700);
  }));

test("a CA left by an earlier install does not count as the current one, and untrust removes both", { skip: onWindows }, () =>
  withNss(FAKE_CERTUTIL, ({ ca }) => {
    const old = ca("old");
    const current = ca("current");
    assert.notEqual(nssNickname(old), nssNickname(current));
    nssTrust(old);
    assert.equal(nssTrusted(current), false, "a check by name alone would have passed here");
    nssTrust(current);
    assert.equal(nssTrusted(current), true);
    assert.equal(nssUntrust(), true);
    assert.equal(nssTrusted(current), false);
    assert.equal(nssTrusted(old), false);
    assert.equal(nssUntrust(), false, "nothing left to remove");
  }));

test("without certutil, trust fails with the package to install and nothing counts as trusted", { skip: onWindows }, () =>
  withNss(null, ({ ca }) => {
    const pem = ca("current");
    assert.equal(nssTrusted(pem), false);
    assert.throws(() => nssTrust(pem), /sudo apt install libnss3-tools/);
    assert.throws(() => nssUntrust(), /ENOENT/);
  }));

test("CA removal never turns store query failures into absence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ca-removal-"));
  const pem = path.join(root, "ca.pem");
  fs.writeFileSync(pem, createCa({ cn: "ClaudeRipple local CA" }).certPem);
  try {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const calls: string[][] = [];
      assert.equal(untrustCa(pem, { platform, run: (command, args) => {
        calls.push([command, ...args]);
        throw new Error("permission denied");
      } }), "failed");
      assert.equal(calls.length, 1);
      assert.equal(untrustCa(path.join(root, "missing.pem"), { platform, run: () => { throw new Error("must not query without a fingerprint"); } }), "missing");
    }
    assert.equal(untrustCa(pem, { platform: "win32", run: () => "0" }), "absent");
    assert.equal(untrustCa(pem, { platform: "linux", run: () => "Certificate Nickname  Trust Attributes\n SSL,S/MIME,JAR/XPI\n" }), "absent");
    assert.equal(untrustCa(pem, { platform: "darwin", run: () => { throw Object.assign(new Error("not found"), { status: 44 }); } }), "absent");
    let queries = 0;
    assert.equal(untrustCa(pem, { platform: "linux", run: (_command, args) => {
      if (args.includes("-D")) return "";
      if (++queries > 1) throw new Error("query failed after deletion");
      return `${nssNickname(pem)} C,,\n`;
    } }), "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real certutil accepts the same calls", { skip: process.env.CLAUDERIPPLE_TEST_REAL_NSS !== "1" || onWindows || !realCertutil() }, () =>
  withNss("", ({ ca }) => {
    // An empty script is not written, so the system certutil is the one on PATH.
    const pem = ca("current");
    nssTrust(pem);
    assert.equal(nssTrusted(pem), true);
    assert.equal(nssUntrust(), true);
    assert.equal(nssTrusted(pem), false);
  }));

// ---- Is the Claude desktop app on this computer? (#183) --------------------------------------

/** Restricts the real filesystem to a temp root: /Applications/Claude.app on the developer's Mac must not count. */
const insideOnly = (root: string) => (file: string): boolean => file.startsWith(root) && fs.existsSync(file);

test("the desktop app counts as present from its data folder, and not from an empty home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-desktop-"));
  try {
    const home = path.join(root, "home");
    const env = { LOCALAPPDATA: path.join(root, "local"), XDG_CONFIG_HOME: path.join(root, "xdg") };
    // The platform's own app-data parent, and the folder names the app uses under it.
    const parent = process.platform === "win32" ? env.LOCALAPPDATA
      : process.platform === "linux" ? env.XDG_CONFIG_HOME
        : path.join(home, "Library", "Application Support");
    const present = () => claudeDesktopPresent({ home, env, exists: insideOnly(root) });
    fs.mkdirSync(home, { recursive: true });
    assert.equal(present(), false, "nothing installed");
    fs.mkdirSync(path.join(parent, "Claude-3p"), { recursive: true });
    assert.equal(present(), true, "the folder picker mode itself uses");
    fs.rmSync(path.join(parent, "Claude-3p"), { recursive: true });
    assert.equal(present(), false);
    fs.mkdirSync(path.join(parent, "Claude"), { recursive: true });
    assert.equal(present(), true, "the app's own data folder");
    fs.rmSync(path.join(parent, "Claude"), { recursive: true });
    assert.equal(present(), false);
    // An explicit CLAUDE_APP_SUPPORT is the user saying where the app lives.
    assert.equal(claudeDesktopPresent({ home, env: { ...env, CLAUDE_APP_SUPPORT: path.join(root, "anywhere") }, exists: insideOnly(root) }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("each platform looks where its own desktop app keeps its data and its install", () => {
  const paths = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, present: string[]): boolean =>
    claudeDesktopPresent({ platform, home, env, exists: (file) => present.includes(file) });
  // macOS: Application Support, and the application bundle.
  assert.equal(paths("darwin", "/Users/u", {}, []), false);
  assert.equal(paths("darwin", "/Users/u", {}, ["/Users/u/Library/Application Support/Claude"]), true);
  assert.equal(paths("darwin", "/Users/u", {}, ["/Users/u/Library/Application Support/Claude-3p"]), true);
  assert.equal(paths("darwin", "/Users/u", {}, ["/Applications/Claude.app"]), true);
  assert.equal(paths("darwin", "/Users/u", {}, ["/Users/u/.config/Claude"]), false, "another platform's place does not count");
  // Windows: under %LOCALAPPDATA%, which falls back to AppData\Local; the installer's folder counts.
  assert.equal(paths("win32", "C:\\Users\\u", { LOCALAPPDATA: "D:\\Local" }, ["C:\\Users\\u\\AppData\\Local\\Claude"]), false);
  assert.equal(paths("win32", "C:\\Users\\u", { LOCALAPPDATA: "D:\\Local" }, ["D:\\Local\\Claude-3p"]), true);
  assert.equal(paths("win32", "C:\\Users\\u", {}, ["C:\\Users\\u\\AppData\\Local\\Claude"]), true);
  assert.equal(paths("win32", "C:\\Users\\u", { LOCALAPPDATA: "D:\\Local" }, ["D:\\Local\\AnthropicClaude"]), true);
  // Linux: $XDG_CONFIG_HOME, or ~/.config; ~/.config/Claude counts either way.
  assert.equal(paths("linux", "/home/u", {}, []), false);
  assert.equal(paths("linux", "/home/u", {}, ["/home/u/.config/Claude"]), true);
  assert.equal(paths("linux", "/home/u", { XDG_CONFIG_HOME: "/x" }, ["/x/Claude-3p"]), true);
  assert.equal(paths("linux", "/home/u", { XDG_CONFIG_HOME: "/x" }, ["/home/u/.config/Claude"]), true);
  assert.equal(paths("linux", "/home/u", { XDG_CONFIG_HOME: "/x" }, ["/home/u/.config/Other"]), false);
  assert.throws(() => assertDesktopPresent({ platform: "linux", home: "/home/u", env: {}, exists: () => false }), (error: Error) => error.message === DESKTOP_ABSENT_MESSAGE && /model mapping/.test(error.message) && /computer that runs the Claude desktop app/.test(error.message));
  assert.doesNotThrow(() => assertDesktopPresent({ platform: "linux", home: "/home/u", env: {}, exists: () => true }));
});

test("applying the app's proxy entry on a computer without the desktop app explains itself and creates no folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-desktop-absent-"));
  const keys = ["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_CONFIG_HOME", "CLAUDE_APP_SUPPORT", "CLAUDE_SETTINGS_PATH"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(root, "local"), XDG_CONFIG_HOME: path.join(root, "xdg"), CLAUDE_SETTINGS_PATH: path.join(root, "settings.json") });
    delete process.env.CLAUDE_APP_SUPPORT;
    // The real filesystem under a temp home, except that a developer's own /Applications/Claude.app does not count.
    const desktop = { exists: insideOnly(root) };
    assert.throws(() => applyAppProxy("http://127.0.0.1:18791", path.join(root, "clauderipple"), undefined, undefined, desktop), (error: Error) => error.message === DESKTOP_ABSENT_MESSAGE);
    assert.deepEqual(fs.readdirSync(home), [], "no app folder was made under the home");
    assert.equal(fs.existsSync(path.join(root, "local")) || fs.existsSync(path.join(root, "xdg")), false);
    // With the app's data folder named explicitly the entry is written as before.
    process.env.CLAUDE_APP_SUPPORT = path.join(root, "desktop-3p");
    const applied = applyAppProxy("http://127.0.0.1:18791", path.join(root, "clauderipple"), undefined, undefined, desktop);
    assert.ok(fs.existsSync(path.join(root, "desktop-3p", "configLibrary", `${applied.id}.json`)));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
