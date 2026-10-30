import test from "node:test";
import assert from "node:assert/strict";
import { failureAction, failureKinds, type FailureAction } from "../src/failure-model.ts";

// The output of the update that failed on 2026-10-29 while cargo held the CPU, as the tray showed it.
const starvedUpdate = `Updating ClaudeRipple 0.12.14 → 0.12.22 (install script, C:\\Users\\me\\.clauderipple)…
Using Node v24.1.0 at C:\\Program Files\\nodejs\\node.exe
Installing clauderipple@0.12.22...

added 7 packages, and changed 127 packages in 54s

38 packages are looking for funding
  run \`npm fund\` for details

✓ certificates already present
✓ config kept: C:\\Users\\me\\.clauderipple\\config.json
✓ scheduled task registered: C:\\Users\\me\\.clauderipple\\clauderipple-router.ps1 (shows as "ClaudeRipple" in Login Items)
✓ router already running
✗ probe failed: router unreachable: connect ECONNREFUSED 127.0.0.1:8790
C:\\Users\\me\\.claude\\settings.json was left as it was, so Claude Code does not depend on a router that is not answering. Fix the router, then run install again.

The router could not be set up (install exited with code 1).
Run again: clauderipple.cmd install
If the router still does not start, run: clauderipple.cmd repair
the installer exited with 1

Command failed: C:\\Program Files\\nodejs\\node.exe C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple\\dist\\cli\\src\\index.js update`;

const all = new Set<FailureAction>(["restart", "repair", "setup", "retry"]);

test("a router that does not answer the final check is named, not the installer's exit code", () => {
  assert.deepEqual(failureKinds(starvedUpdate), ["router-unresponsive"]);
  assert.equal(failureAction(failureKinds(starvedUpdate), all), "setup");
});

test("a restart that was refused leaves the router on the old version, even when the probe passes", () => {
  const out = [
    "✓ router already running",
    "  the running router is 0.12.14; restarting it on 0.12.22",
    "! not restarted: the scheduled task belongs to another ClaudeRipple installation (this one's was never registered)",
    "✓ end-to-end probe passed (upstream answered HTTP/1.1 401 Unauthorized, 275ms)",
  ].join("\n");
  assert.deepEqual(failureKinds(out), ["router-not-switched"]);
  assert.equal(failureAction(failureKinds(out), all), "restart");
  const failed = "C:\\Users\\me\\.claude\\settings.json was left as it was: the router was not switched to 0.12.22. Run `clauderipple restart`, then install again.";
  assert.deepEqual(failureKinds(failed), ["router-not-switched"]);
  assert.deepEqual(failureKinds("✗ router not restarted — run `clauderipple repair` (or `clauderipple install`)"), ["router-not-switched"]);
});

test("a router that never started is not also reported as not answering", () => {
  const out = "✗ could not start the router (scheduled task)\n✗ probe failed: router unreachable: connect ECONNREFUSED 127.0.0.1:8790";
  assert.deepEqual(failureKinds(out), ["router-not-started"]);
  assert.equal(failureAction(failureKinds(out), all), "repair");
});

test("each probe failure names its own cause", () => {
  const cases: [string, string][] = [
    ["✗ probe failed: timeout", "router-unresponsive"],
    ["✗ probe failed: CONNECT refused: HTTP/1.1 502 Bad Gateway", "anthropic-unreachable"],
    ["✗ probe failed: TLS error: socket hang up", "anthropic-unreachable"],
    ["✗ probe failed: upstream answered HTTP/1.1 503 Service Unavailable", "anthropic-unreachable"],
    ["✗ probe failed: connection closed without a status line", "anthropic-unreachable"],
    ["✗ probe failed: cannot read CA: ENOENT: no such file or directory", "certificate"],
    ["✗ probe failed: TLS not authorized: UNABLE_TO_VERIFY_LEAF_SIGNATURE", "certificate"],
  ];
  for (const [line, kind] of cases) assert.deepEqual(failureKinds(line), [kind], line);
});

test("startup entry failures on each platform", () => {
  for (const line of [
    "Error: Register-ScheduledTask failed: Access is denied. (0x80070005)",
    "Error: scheduled task lookup failed: Get-ScheduledTask timed out",
    "Error: launchctl bootstrap failed: Bootstrap failed: 5: Input/output error",
    "Error: systemctl --user enable clauderipple.service failed: Failed to connect to bus",
    "! router started without the scheduled task. Run `clauderipple repair`, then `clauderipple restart` to put it back under the scheduled task.",
  ]) {
    assert.deepEqual(failureKinds(line), ["startup-entry"], line);
  }
  assert.equal(failureAction(["startup-entry"], all), "repair");
});

test("npm and download failures", () => {
  const busy = [
    "npm error code EBUSY",
    "npm error syscall rename",
    "npm error EBUSY: resource busy or locked, rename 'C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple' -> 'C:\\Users\\me\\.clauderipple\\node_modules\\.clauderipple-x'",
  ].join("\n");
  assert.deepEqual(failureKinds(busy), ["files-unwritable"]);
  assert.deepEqual(failureKinds("npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/clauderipple'"), ["files-unwritable"]);
  assert.deepEqual(failureKinds("npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device, write"), ["disk-full"]);
  const offline = "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/clauderipple failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org";
  assert.deepEqual(failureKinds(offline), ["download"]);
  // PowerShell's own message is in the system language; its error id is not.
  const irm = [
    "irm : 원격 이름을 확인할 수 없습니다: 'raw.githubusercontent.com'",
    "    + CategoryInfo          : InvalidOperation: (System.Net.HttpWebRequest:HttpWebRequest) [Invoke-RestMethod], WebException",
    "    + FullyQualifiedErrorId : WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeRestMethodCommand",
  ].join("\n");
  assert.deepEqual(failureKinds(irm), ["download"]);
  assert.deepEqual(failureKinds("the installer download failed (22)\ncurl: (6) Could not resolve host: raw.githubusercontent.com"), ["download"]);
  assert.deepEqual(failureKinds("Exception: the Node download does not match its published checksum"), ["download"]);
  assert.deepEqual(failureKinds("Error: npm registry answered HTTP 503"), ["download"]);
});

test("another proxy in Claude's settings has no button: it has to be removed first", () => {
  const out = 'error: settings.json env.HTTPS_PROXY is already "http://127.0.0.1:9000". Re-run with --force to replace it, or uninstall the other proxy first.';
  assert.deepEqual(failureKinds(out), ["foreign-proxy"]);
  assert.equal(failureAction(failureKinds(out), all), null);
});

test("several failures are listed in order, each once", () => {
  const out = [
    "npm error code EBUSY",
    "! not restarted: the running instance could not be verified as this installation's",
    "npm error EBUSY: resource busy or locked, unlink 'x'",
  ].join("\n");
  assert.deepEqual(failureKinds(out), ["files-unwritable", "router-not-switched"]);
});

test("the lines of a successful update match nothing", () => {
  const ok = [
    "Updating ClaudeRipple 0.12.21 → 0.12.22 (npm, /usr/local)…",
    "added 7 packages, and changed 127 packages in 54s",
    "✓ certificates already present",
    "✓ config kept: /Users/me/.clauderipple/config.json",
    "✓ launchd agent registered: /Users/me/Library/LaunchAgents/com.clauderipple.router.plist",
    "✓ router already running",
    "  the running router is 0.12.21; restarting it on 0.12.22",
    "✓ router restarted (in-flight model calls were allowed to finish)",
    "✓ end-to-end probe passed (upstream answered HTTP/1.1 401 Unauthorized, 275ms)",
    "✓ /Users/me/.claude/settings.json already correct",
    "✓ updated",
  ].join("\n");
  assert.deepEqual(failureKinds(ok), ["unknown"]);
  assert.deepEqual(failureKinds(""), ["unknown"]);
});

test("the action offered is the first one the caller can run", () => {
  assert.equal(failureAction(["download"], new Set(["setup", "restart", "repair"])), null, "only an update can be retried");
  assert.equal(failureAction(["download"], all), "retry");
  assert.equal(failureAction(["foreign-proxy", "router-not-switched"], all), "restart");
  assert.equal(failureAction(["unknown"], all), null);
});
