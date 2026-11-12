// caTrustedAsync: the router's background certificate check (#159). Commands are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { caTrustedAsync } from "../src/picker.ts";
import { createCa } from "../../router/src/x509.ts";

function caFile(t: import("node:test").TestContext): { pem: string; fingerprint: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ca-async-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const certPem = createCa({ cn: "ClaudeRipple local CA" }).certPem;
  const pem = path.join(root, "ca.pem");
  fs.writeFileSync(pem, certPem);
  return { pem, fingerprint: new X509Certificate(certPem).fingerprint.replace(/:/g, "") };
}

const timeout = () => Object.assign(new Error("timed out"), { timedOut: true, code: "ETIMEDOUT" });

test("Windows: the Cert: store count decides, and the command is the same bounded PowerShell query", async t => {
  const { pem, fingerprint } = caFile(t);
  const seen: string[][] = [];
  const run = (answer: string) => async (command: string, args: string[]) => { seen.push([command, ...args]); return answer; };
  assert.equal(await caTrustedAsync(pem, { platform: "win32", run: run("1\r\n") }), true);
  assert.equal(await caTrustedAsync(pem, { platform: "win32", run: run("0\r\n") }), false);
  assert.equal(seen[0]![0], "powershell.exe");
  assert.ok(seen[0]!.some(arg => arg.includes("Cert:\\CurrentUser\\Root") && arg.includes(fingerprint)));
  assert.ok(!seen[0]!.includes("-Interactive"));
});

test("a command that ran out of time is unknown (null), a command that failed is not trusted (false)", async t => {
  const { pem } = caFile(t);
  assert.equal(await caTrustedAsync(pem, { platform: "win32", run: async () => { throw timeout(); } }), null);
  assert.equal(await caTrustedAsync(pem, { platform: "win32", run: async () => { throw new Error("Cannot find drive 'Cert'"); } }), false);
  assert.equal(await caTrustedAsync(pem, { platform: "darwin", run: async () => { throw timeout(); } }), null);
});

test("an unreadable or missing CA file is not trusted and runs no command", async () => {
  assert.equal(await caTrustedAsync("/no/such/ca.pem", { platform: "win32", run: async () => assert.fail("no command") }), false);
});

test("macOS: trust settings, the keychain item and verify-cert must all agree, in that order", async t => {
  const { pem, fingerprint } = caFile(t);
  const calls: string[] = [];
  const run = async (command: string, args: string[]): Promise<string> => {
    calls.push(`${command} ${args[0]}`);
    if (args[0] === "trust-settings-export") return `<key>${fingerprint}</key>`;
    if (args[0] === "find-certificate") return `SHA-1 hash: ${fingerprint}`;
    return "";
  };
  assert.equal(await caTrustedAsync(pem, { platform: "darwin", run }), true);
  assert.deepEqual(calls, ["security trust-settings-export", "security find-certificate", "security verify-cert"]);
  calls.length = 0;
  assert.equal(await caTrustedAsync(pem, { platform: "darwin", run: async (c, a) => { calls.push(a[0]!); return "<key>OTHER</key>"; } }), false);
  assert.deepEqual(calls, ["trust-settings-export"], "no trust entry: stops there");
});
