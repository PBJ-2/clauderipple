import { test } from "node:test";
import assert from "node:assert/strict";
import { readUpdateSeen, readReplacementTries, rememberUpdate, releaseNotesUrl, replacementExhausted, nextReplacementTries, resolveTrayVersion, updateNotice, REPLACEMENT_LIMIT, type RouterUpdate, type UpdateSeen } from "../src/update-model.ts";

const empty = (): UpdateSeen => ({ updated: [], available: [] });
const completed: RouterUpdate = { enabled: true, kind: "script", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 };

test("confirmed update notifies once and relaunches only an old tray", () => {
  const notice = updateNotice("1.1.0", "1.0.0", completed, empty());
  assert.deepEqual(notice, { kind: "updated", version: "1.1.0", relaunch: true });
  const seen = readUpdateSeen(JSON.parse(JSON.stringify(rememberUpdate(empty(), notice!))));
  assert.equal(updateNotice("1.1.0", "1.0.0", completed, seen), null, "persists across app restart");
  assert.deepEqual(updateNotice("1.1.0", "1.1.0", completed, empty()), { kind: "updated", version: "1.1.0", relaunch: false });
});
test("old routers, pending attempts and stale completion records do not relaunch", () => {
  assert.equal(updateNotice("1.0.0", "1.0.0", undefined, empty()), null);
  assert.equal(updateNotice("1.0.0", "1.0.0", { running: true }, empty()), null);
  assert.equal(updateNotice("1.1.0", "1.0.0", { ...completed, running: true }, empty()), null, "wait for the installer to finish preparing the tray runtime");
  assert.equal(updateNotice("1.2.0", "1.0.0", completed, empty()), null);
  assert.equal(updateNotice("1.1.0", "1.0.0", { lastUpdatedTo: "1.1.0" }, empty()), null);
  assert.equal(updateNotice("1.1.0", "1.0.0", { ...completed, lastUpdatedFrom: "1.1.0" }, empty()), null);
});
for (const kind of ["script", "npm", "packaged", "checkout", "unknown"]) {
  test(`available notice policy for ${kind}`, () => {
    const state: RouterUpdate = { enabled: true, kind, available: "1.1.0" };
    assert.equal(updateNotice("1.0.0", "1.0.0", state, empty())?.kind ?? null, ["script", "npm"].includes(kind) ? null : "available");
    const notice = updateNotice("1.0.0", "1.0.0", { ...state, enabled: false }, empty());
    assert.deepEqual(notice, { kind: "available", version: "1.1.0" });
    const seen = readUpdateSeen(JSON.parse(JSON.stringify(rememberUpdate(empty(), notice!))));
    assert.equal(updateNotice("1.0.0", "1.0.0", { ...state, enabled: false }, seen), null);
    assert.equal(updateNotice("1.0.0", "1.0.0", { ...state, enabled: false, running: true }, empty()), null);
  });
}
test("available and completed notifications have independent version deduplication", () => {
  const seen = rememberUpdate(empty(), { kind: "available", version: "1.1.0" });
  const notice = updateNotice("1.1.0", "1.0.0", completed, seen)!;
  assert.equal(notice.kind, "updated");
  const both = rememberUpdate(seen, notice);
  assert.deepEqual(rememberUpdate(both, notice), both);
  assert.equal(updateNotice("1.1.0", "1.0.0", { enabled: false, available: "1.1.0" }, empty()), null);
});
test("failed tray replacement retries the same version independently of an already delivered notice", async () => {
  const module = await import("../src/update-model.ts");
  assert.equal(typeof module.TrayReplacement, "function", "replacement is separate from notification deduplication");
  let now = 0, calls = 0;
  const replacement = new module.TrayReplacement(() => now);
  const seen = rememberUpdate(empty(), updateNotice("1.1.0", "1.0.0", completed, empty())!);
  assert.equal(updateNotice("1.1.0", "1.0.0", completed, seen), null);
  const run = async () => { if (++calls === 1) throw new Error("launcher failed"); };
  await assert.rejects(replacement.reconcile("1.1.0", "1.0.0", completed, run), /launcher failed/);
  await replacement.reconcile("1.1.0", "1.0.0", completed, run);
  assert.equal(calls, 1, "polls do not cause a tight retry loop");
  now += 60_000;
  await replacement.reconcile("1.1.0", "1.0.0", completed, run);
  assert.equal(calls, 2);
  now += 60_000;
  await replacement.reconcile("1.1.0", "1.0.0", completed, run);
  assert.equal(calls, 2, "only a successful launch is complete");
});

test("malformed notification history is rejected at the file boundary", () => {
  for (const value of [null, {}, { updated: [1], available: [] }, { updated: [], available: "1.0.0" }]) assert.throws(() => readUpdateSeen(value));
});

test("the tray's version is the package's, not Electron's, outside a packaged build", () => {
  // `electron main.js` — how the CLI starts an npm install — made app.getVersion() answer 38.8.6.
  assert.equal(resolveTrayVersion(false, "38.8.6", "0.12.14"), "0.12.14");
  assert.equal(resolveTrayVersion(false, "38.8.6", " 0.12.14\n"), "0.12.14");
  assert.equal(resolveTrayVersion(true, "0.12.14", "0.12.13"), "0.12.14", "the bundle is the truth in a packaged app");
  for (const missing of [null, "", "   "]) assert.equal(resolveTrayVersion(false, "38.8.6", missing), "38.8.6", `no package version (${JSON.stringify(missing)}) falls back`);
});

test("replacement attempts are counted per version pair and stop the loop", () => {
  assert.equal(replacementExhausted(null, "1.1.0", "1.0.0"), false, "nothing tried yet");
  let tries = nextReplacementTries(null, "1.1.0", "1.0.0");
  assert.deepEqual(tries, { routerVersion: "1.1.0", trayVersion: "1.0.0", attempts: 1 });
  for (let i = 1; i < REPLACEMENT_LIMIT; i++) tries = nextReplacementTries(readReplacementTries(JSON.parse(JSON.stringify(tries))), "1.1.0", "1.0.0");
  assert.equal(tries.attempts, REPLACEMENT_LIMIT);
  assert.equal(replacementExhausted(tries, "1.1.0", "1.0.0"), true);
  assert.equal(replacementExhausted(tries, "1.2.0", "1.0.0"), false, "a new router version is a new attempt");
  assert.equal(replacementExhausted(tries, "1.1.0", "1.1.0"), false, "a tray that caught up is not stuck");
  assert.deepEqual(nextReplacementTries(tries, "1.1.0", "1.1.0"), { routerVersion: "1.1.0", trayVersion: "1.1.0", attempts: 1 }, "a different pair starts its own count");
});

test("a damaged replacement state is ignored rather than stopping updates", () => {
  for (const value of [null, {}, { routerVersion: "1.1.0" }, { routerVersion: "1.1.0", trayVersion: "1.0.0", attempts: "3" }, { routerVersion: "1.1.0", trayVersion: "1.0.0", attempts: Infinity }]) {
    assert.equal(readReplacementTries(value), null);
  }
  assert.deepEqual(readReplacementTries(JSON.parse('{"routerVersion":"1.1.0","trayVersion":"1.0.0","attempts":-2}')), { routerVersion: "1.1.0", trayVersion: "1.0.0", attempts: 0 });
});

test("an update notice links to that version's release notes", () => {
  assert.equal(releaseNotesUrl("0.12.30"), "https://github.com/PBJ-2/clauderipple/releases/tag/v0.12.30");
  assert.equal(releaseNotesUrl("1.0.0-beta.2"), "https://github.com/PBJ-2/clauderipple/releases/tag/v1.0.0-beta.2");
  for (const odd of ["", "v0.12.30", "0.12", "0.12.30/../../x", "0.12.30?x=1"]) {
    assert.equal(releaseNotesUrl(odd), "https://github.com/PBJ-2/clauderipple/releases/latest", odd);
  }
});
