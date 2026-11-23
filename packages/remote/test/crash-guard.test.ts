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

test("an unhandled rejection is logged with its stack and the host keeps running (#162)", () => {
  const f = fixture();
  f.proc.emit("unhandledRejection", new Error("interrupt failed"), Promise.resolve());
  assert.deepEqual(f.exits, []);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0]!, /^\[host\] unhandled rejection \(host keeps running\) \[test\]: Error: interrupt failed \| +at /);
  assert.ok(!f.lines[0]!.includes("\n"), "one line, so a log reader sees the whole error");
});

test("a rejection with a reason that is not an Error is still readable", () => {
  const f = fixture();
  f.proc.emit("unhandledRejection", "plain text", Promise.resolve());
  f.proc.emit("unhandledRejection", { code: 7 }, Promise.resolve());
  f.proc.emit("unhandledRejection", undefined, Promise.resolve());
  assert.match(f.lines[0]!, /: plain text$/);
  assert.match(f.lines[1]!, /: \{"code":7\}$/);
  assert.match(f.lines[2]!, /: undefined$/);
  assert.deepEqual(f.exits, []);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(describeError(cycle), "[object Object]");
});

test("an uncaught exception is logged and exits non-zero once, so the supervisor relaunches the host", () => {
  const f = fixture();
  f.proc.emit("uncaughtException", new Error("boom"), "uncaughtException");
  f.proc.emit("uncaughtException", new Error("second"), "uncaughtException");
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.lines.length, 2, "both are logged");
  assert.match(f.lines[0]!, /uncaught exception \(uncaughtException\) \[test\]: Error: boom .*exiting with code 1/);
});

test("a failing context never hides the error", () => {
  const proc = new EventEmitter();
  const lines: string[] = [];
  installCrashHandlers(proc as unknown as Parameters<typeof installCrashHandlers>[0], { log: line => lines.push(line), exit: () => {}, context: () => { throw new Error("no context"); } });
  proc.emit("unhandledRejection", new Error("x"), Promise.resolve());
  assert.match(lines[0]!, /unhandled rejection \(host keeps running\): Error: x/);
});

test("in a real process a stray rejection leaves it running and an uncaught exception exits 1", () => {
  const script = (body: string) => `import { installCrashHandlers } from ${JSON.stringify(guard)};
    installCrashHandlers(process, { log: l => process.stderr.write(l + "\\n"), exit: c => process.exit(c) });
    ${body}`;
  const rejected = spawnSync(process.execPath, ["--input-type=module", "-e", script(`Promise.reject(new Error("stray")); setTimeout(() => process.exit(0), 50);`)], { encoding: "utf8", timeout: 20_000 });
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.match(rejected.stderr, /unhandled rejection \(host keeps running\): Error: stray/);
  const thrown = spawnSync(process.execPath, ["--input-type=module", "-e", script(`setTimeout(() => { throw new Error("thrown"); }, 10); setTimeout(() => process.exit(0), 2000);`)], { encoding: "utf8", timeout: 20_000 });
  assert.equal(thrown.status, 1, thrown.stderr);
  assert.match(thrown.stderr, /uncaught exception .*Error: thrown/);
});
