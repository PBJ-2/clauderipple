import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeError, installCrashHandlers } from "../src/crash-guard.ts";

const guard = fileURLToPath(new URL("../src/crash-guard.ts", import.meta.url));

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
