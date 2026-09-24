import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nssNickname, nssTrust, nssTrusted, nssUntrust } from "../src/picker.ts";
import { createCa } from "../../router/src/x509.ts";

const onWindows = process.platform === "win32";

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
    assert.equal(nssUntrust(), false);
  }));

test("the real certutil accepts the same calls", { skip: onWindows || !realCertutil() }, () =>
  withNss("", ({ ca }) => {
    // An empty script is not written, so the system certutil is the one on PATH.
    const pem = ca("current");
    nssTrust(pem);
    assert.equal(nssTrusted(pem), true);
    assert.equal(nssUntrust(), true);
    assert.equal(nssTrusted(pem), false);
  }));
