import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeError, installCrashHandlers, syncLineWriter } from "../src/crash-guard.ts";

// A file URL, not a path: a Windows path such as D:\... in an import specifier is read as a "d:" URL.
const guard = new URL("../src/crash-guard.ts", import.meta.url).href;

function fixture() {
  const proc = new EventEmitter();
  const lines: string[] = [];
  const exits: number[] = [];
  installCrashHandlers(proc as unknown as Parameters<typeof installCrashHandlers>[0], { log: line => lines.push(line), exit: code => exits.push(code), context: () => " [test]" });
  return { proc, lines, exits };
}

test("an unhandled rejection is logged with its stack and the host exits non-zero, as an uncaught exception does (#162)", () => {
  const f = fixture();
  f.proc.emit("unhandledRejection", new Error("interrupt failed"), Promise.resolve());
  assert.deepEqual(f.exits, [1], "a host that carries on can acknowledge messages nobody runs; the supervisor restarts it");
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0]!, /^\[host\] unhandled rejection \[test\]: Error: interrupt failed \| +at .*exiting with code 1 so the supervisor restarts the host$/);
  assert.ok(!f.lines[0]!.includes("\n"), "one line, so a log reader sees the whole error");
});

test("a rejection with a reason that is not an Error is still readable and still exits", () => {
  for (const [reason, tail] of [["plain text", /: plain text; exiting/], [{ code: 7 }, /: \{"code":7\}; exiting/], [undefined, /: undefined; exiting/]] as const) {
    const f = fixture();
    f.proc.emit("unhandledRejection", reason, Promise.resolve());
    assert.match(f.lines[0]!, tail);
    assert.deepEqual(f.exits, [1]);
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(describeError(cycle), "[object Object]");
});

test("an uncaught exception is logged and exits non-zero once, so the supervisor relaunches the host", () => {
  const f = fixture();
  f.proc.emit("uncaughtException", new Error("boom"), "uncaughtException");
  f.proc.emit("uncaughtException", new Error("second"), "uncaughtException");
  f.proc.emit("unhandledRejection", new Error("third"), Promise.resolve());
  assert.deepEqual(f.exits, [1], "one exit however many errors arrive while it happens");
  assert.equal(f.lines.length, 3, "every one is logged");
  assert.match(f.lines[0]!, /uncaught exception \(uncaughtException\) \[test\]: Error: boom .*exiting with code 1/);
});

test("a failing context never hides the error, and a failing log never keeps the process", () => {
  const proc = new EventEmitter();
  const lines: string[] = [];
  installCrashHandlers(proc as unknown as Parameters<typeof installCrashHandlers>[0], { log: line => lines.push(line), exit: () => {}, context: () => { throw new Error("no context"); } });
  proc.emit("unhandledRejection", new Error("x"), Promise.resolve());
  assert.match(lines[0]!, /unhandled rejection: Error: x/);
  const exits: number[] = [];
  const broken = new EventEmitter();
  installCrashHandlers(broken as unknown as Parameters<typeof installCrashHandlers>[0], { log: () => { throw new Error("stderr closed"); }, exit: code => exits.push(code) });
  broken.emit("uncaughtException", new Error("y"), "uncaughtException");
  assert.deepEqual(exits, [1]);
});

test("in a real process both a stray rejection and an uncaught exception log with a stack and exit 1", () => {
  const script = (body: string) => `import { installCrashHandlers } from ${JSON.stringify(guard)};
    installCrashHandlers(process, { log: l => process.stderr.write(l + "\\n"), exit: c => process.exit(c) });
    ${body}`;
  const rejected = spawnSync(process.execPath, ["--input-type=module", "-e", script(`Promise.reject(new Error("stray")); setTimeout(() => process.exit(0), 2000);`)], { encoding: "utf8", timeout: 20_000 });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /unhandled rejection: Error: stray \| +at /);
  const thrown = spawnSync(process.execPath, ["--input-type=module", "-e", script(`setTimeout(() => { throw new Error("thrown"); }, 10); setTimeout(() => process.exit(0), 2000);`)], { encoding: "utf8", timeout: 20_000 });
  assert.equal(thrown.status, 1, thrown.stderr);
  assert.match(thrown.stderr, /uncaught exception .*Error: thrown/);
});

test("the crash line is written synchronously, before the process is asked to exit", () => {
  const order: string[] = [];
  const proc = new EventEmitter();
  installCrashHandlers(proc as unknown as Parameters<typeof installCrashHandlers>[0], { log: line => order.push(`async:${line}`), logSync: line => order.push(`sync:${line}`), exit: code => order.push(`exit:${code}`), context: () => " [test]" });
  proc.emit("unhandledRejection", new Error("backed up"), Promise.resolve());
  assert.equal(order.length, 2, "the queued log is not used when the synchronous one worked");
  assert.match(order[0]!, /^sync:\[host\] unhandled rejection \[test\]: Error: backed up \| +at /);
  assert.equal(order[1], "exit:1");
});

test("when the synchronous write throws, the ordinary log is tried, and the exit still happens", () => {
  const order: string[] = [];
  const proc = new EventEmitter();
  installCrashHandlers(proc as unknown as Parameters<typeof installCrashHandlers>[0], { log: line => order.push(`async:${line.slice(0, 45)}`), logSync: () => { throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" }); }, exit: code => order.push(`exit:${code}`) });
  proc.emit("uncaughtException", new Error("z"), "uncaughtException");
  assert.deepEqual(order, ["async:[host] uncaught exception (uncaughtException)", "exit:1"]);
  const silent = new EventEmitter();
  const exits: number[] = [];
  installCrashHandlers(silent as unknown as Parameters<typeof installCrashHandlers>[0], { log: () => { throw new Error("closed"); }, logSync: () => { throw new Error("closed"); }, exit: code => exits.push(code) });
  silent.emit("unhandledRejection", new Error("w"), Promise.resolve());
  assert.deepEqual(exits, [1], "no log can be written and the process still ends");
});

test("syncLineWriter puts a stamped line in the file before it returns", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "log.txt");
  const fd = fs.openSync(file, "w");
  t.after(() => { try { fs.closeSync(fd); } catch { /* already closed */ } });
  syncLineWriter(fd, () => new Date("2026-11-23T01:02:03.000Z"))("[host] boom | at x");
  assert.equal(fs.readFileSync(file, "utf8"), "2026-11-23T01:02:03.000Z [host] boom | at x\n");
});

test("a real host process leaves the whole stack on a stderr pipe that already holds 200 kB, then exits 1", () => {
  // The 200 kB write ahead of the crash keeps the pipe busy, so a queued write would still be pending at exit.
  const script = `import { installCrashHandlers, syncLineWriter } from ${JSON.stringify(guard)};
    installCrashHandlers(process, { log: l => process.stderr.write(l + "\\n"), logSync: syncLineWriter(2), exit: c => process.exit(c) });
    process.stderr.write("x".repeat(200000) + "\\n");
    function deep(n) { if (n === 0) throw new Error("deep failure"); deep(n - 1); }
    setTimeout(() => deep(5), 10); setTimeout(() => process.exit(0), 3000);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000, maxBuffer: 10_000_000 });
  assert.equal(r.status, 1, r.stderr.slice(-500));
  assert.match(r.stderr, /\d{4}-\d\d-\d\dT[\d:.]+Z \[host\] uncaught exception \(uncaughtException\): Error: deep failure \| +at deep .*exiting with code 1/);
});
