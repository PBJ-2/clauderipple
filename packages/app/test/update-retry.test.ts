import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { readUpdateSeen, readReplacementTries, nextReplacementTries, rememberUpdate, releaseNotesUrl, replacementExhausted, updateNotice, TrayReplacement, REPLACEMENT_LIMIT } from "../src/update-model.ts";

// Execute the real Electron orchestration, replacing only the OS/CLI/notification boundaries.
const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const source = main.slice(main.indexOf("let updateSeen:"), main.indexOf("async function checkForUpdate"));
export function updateHarness(sourceText: string, home: string, trayVersion = "1.0.0") {
  const boundary = { opened: [] as string[], closed: 0, click: undefined as undefined | (() => void), calls: 0, notifications: 0, quits: 0, locks: 0, fail: true, visible: false, args: [] as string[], env: {} as Record<string, string | undefined> };
  const create = new Function("deps", `
    const { fs, path, home, readUpdateSeen, readReplacementTries, rememberUpdate, releaseNotesUrl, replacementExhausted, nextReplacementTries, updateNotice, TrayReplacement, REPLACEMENT_LIMIT, boundary, trayVersion: trayVersionValue } = deps;
    let updating = false, routerUpdateUntil = 0, updateNotification = null, availableUpdate = null;
    const trayVersion = () => trayVersionValue;
    const app = { isPackaged: false, getVersion: () => trayVersionValue, releaseSingleInstanceLock() {}, requestSingleInstanceLock() { boundary.locks++; return true; }, quit() { boundary.quits++; } };
    const runCliResult = async (args, timeout, env) => { boundary.calls++; boundary.args = args; boundary.env = env || {}; return { ok: !boundary.fail, output: 'launch refused' }; };
    const windowVisible = () => boundary.visible === true;
    const Notification = class { static isSupported() { return true; } on(event, fn) { if (event === "click") boundary.click = fn; } show() { boundary.notifications++; } close() { boundary.closed++; } };
    const shell = { openExternal: async url => { boundary.opened.push(url); } };
    const L = { autoUpdated: v => v, autoAvailable: v => v, trayReplaceGaveUp: v => v }, notifyIcon = () => undefined;
    ${stripTypeScriptTypes(sourceText)}
    return handleRouterUpdate;
  `);
  const handle = create({ fs, path, home, readUpdateSeen, readReplacementTries, rememberUpdate, releaseNotesUrl, replacementExhausted, nextReplacementTries, updateNotice, TrayReplacement, REPLACEMENT_LIMIT, boundary, trayVersion }) as (status: object) => Promise<void>;
  return { handle, boundary };
}

test("a replacement tray shows the dashboard only when it was already open", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-visible-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { handle, boundary } = updateHarness(source, home);
  boundary.fail = false;
  boundary.visible = true;
  await handle({ version: "1.1.0", autoUpdate: { kind: "script", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 } });
  assert.deepEqual(boundary.args, ["tray", "--at-login"]);
  assert.equal(boundary.env.CLAUDERIPPLE_APP_SHOW, "1");
  assert.equal(boundary.quits, 1);
});

test("real tray polling retries failed replacement without duplicating notification or completing before launch", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-retry-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { handle, boundary } = updateHarness(source, home);
  const status = { version: "1.1.0", autoUpdate: { kind: "script", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 } };
  await assert.rejects(handle(status), /launch refused/);
  assert.equal(boundary.calls, 1);
  // B14: the replacement stays in the tray; only a dashboard that was up is shown again.
  assert.deepEqual(boundary.args, ["tray", "--at-login"]);
  assert.equal(Object.hasOwn(boundary.env, "CLAUDERIPPLE_APP_SHOW"), false);
  assert.equal(boundary.quits, 0);
  assert.equal(boundary.locks, 1);
  assert.equal(boundary.notifications, 1);
  await handle(status);
  assert.equal(boundary.calls, 1);
  t.mock.timers.tick(60_000);
  boundary.fail = false;
  await handle(status);
  assert.equal(boundary.calls, 2);
  assert.equal(boundary.quits, 1);
  assert.equal(boundary.notifications, 1);
});

test("a tray that comes back reporting the old version stops being replaced instead of looping", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-loop-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const status = { version: "1.1.0", autoUpdate: { kind: "npm", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 } };
  // Every launch is a new process that reports the same 1.0.0 tray: the 0.12.14 loop, where the
  // tray's own version never matched the router's.
  for (let launch = 1; launch <= REPLACEMENT_LIMIT; launch++) {
    const { handle, boundary } = updateHarness(source, home);
    boundary.fail = false;
    await handle(status);
    assert.equal(boundary.calls, 1, `launch ${launch} replaces the tray`);
    assert.equal(boundary.quits, 1);
  }
  const saved = readReplacementTries(JSON.parse(fs.readFileSync(path.join(home, "tray-replacement.json"), "utf8")));
  assert.deepEqual(saved, { routerVersion: "1.1.0", trayVersion: "1.0.0", attempts: REPLACEMENT_LIMIT });
  const { handle, boundary } = updateHarness(source, home);
  boundary.fail = false;
  await handle(status);
  assert.equal(boundary.calls, 0, "no further launch once the pair cannot converge");
  assert.equal(boundary.quits, 0);
  // The trays that quit posted nothing, so the one that stays says why and what it updated to.
  assert.equal(boundary.notifications, 2, "says once why it stays where it is, and posts the update");
  await handle(status);
  assert.equal(boundary.notifications, 2, "not on every poll");
});

test("the updated notice comes from the tray that stays, and opens that version's release notes", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-notes-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const status = { version: "1.1.0", autoUpdate: { kind: "npm", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 } };
  const old = updateHarness(source, home, "1.0.0");
  old.boundary.fail = false;
  await old.handle(status);
  assert.equal(old.boundary.quits, 1, "the old tray is replaced");
  assert.equal(old.boundary.notifications, 0, "and does not post a notice that dies with it");
  const fresh = updateHarness(source, home, "1.1.0");
  await fresh.handle(status);
  assert.equal(fresh.boundary.calls, 0, "the new tray needs no replacement");
  assert.equal(fresh.boundary.notifications, 1);
  fresh.boundary.click?.();
  assert.deepEqual(fresh.boundary.opened, [releaseNotesUrl("1.1.0")]);
  await fresh.handle(status);
  assert.equal(fresh.boundary.notifications, 1, "once");
});

test("a notice posted by a tray whose replacement failed is posted again by the tray that replaces it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-repost-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const status = { version: "1.1.0", autoUpdate: { kind: "npm", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 } };
  const old = updateHarness(source, home, "1.0.0");
  await assert.rejects(old.handle(status), /launch refused/);
  assert.equal(old.boundary.notifications, 1, "the tray that stays posts it");
  t.mock.timers.tick(60_000);
  old.boundary.fail = false;
  await old.handle(status);
  assert.equal(old.boundary.quits, 1);
  assert.equal(old.boundary.closed, 1, "its notice, whose click dies with it, is withdrawn");
  const fresh = updateHarness(source, home, "1.1.0");
  await fresh.handle(status);
  assert.equal(fresh.boundary.notifications, 1, "and the new tray posts it with a live click");
  fresh.boundary.click?.();
  assert.deepEqual(fresh.boundary.opened, [releaseNotesUrl("1.1.0")]);
});
