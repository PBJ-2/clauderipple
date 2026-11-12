// execBounded: the deadline fires even when the child never lets go of its pipes (#159, #162).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execBounded, killProcessTree, type BoundedChild, type BoundedSpawn } from "../src/bounded-exec.ts";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean { this.killed.push(String(signal)); return true; }
}

function fakeSpawner(): { spawn: BoundedSpawn; children: FakeChild[]; calls: { file: string; args: string[]; detached: unknown }[] } {
  const children: FakeChild[] = [];
  const calls: { file: string; args: string[]; detached: unknown }[] = [];
  return {
    children, calls,
    spawn: (file, args, options) => { calls.push({ file, args, detached: options.detached }); const child = new FakeChild(); children.push(child); return child as unknown as BoundedChild; },
  };
}

test("the deadline fires while the child never closes its stdio, kills the tree and rejects at once", async () => {
  const { spawn, children } = fakeSpawner();
  const killed: BoundedChild[] = [];
  const started = Date.now();
  await assert.rejects(
    execBounded("powershell.exe", ["-Command", "hang"], { timeoutMs: 40, spawn, killTree: child => killed.push(child) }),
    (error: { timedOut?: boolean; code?: unknown }) => error.timedOut === true && error.code === "ETIMEDOUT",
  );
  assert.ok(Date.now() - started < 1000, "no wait for 'close'");
  assert.deepEqual(killed, [children[0]], "the whole tree is killed once");
  assert.equal(children[0]!.stdout.destroyed, true, "the pipes are destroyed so a grandchild holding them cannot keep the loop waiting");
  assert.equal(children[0]!.stderr.destroyed, true);
});

test("on Windows a child that already exited is not killed by PID at the deadline, while its pipes are still let go", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const { spawn, children } = fakeSpawner();
    const killed: BoundedChild[] = [];
    const result = execBounded("powershell.exe", [], { timeoutMs: 40, platform, spawn, killTree: child => killed.push(child) });
    // PowerShell ended, but something it started still holds stdout: 'close' never comes.
    children[0]!.emit("exit", 0, null);
    await assert.rejects(result, (error: { timedOut?: boolean }) => error.timedOut === true);
    assert.equal(children[0]!.stdout.destroyed, true);
    // Windows can give that PID to an unrelated process; a POSIX group ID is not reused while the group lives.
    assert.equal(killed.length, platform === "win32" ? 0 : 1, platform);
  }
});

test("it settles exactly once: a close after the deadline changes nothing", async () => {
  const { spawn, children } = fakeSpawner();
  let kills = 0;
  const result = execBounded("x", [], { timeoutMs: 20, spawn, killTree: () => { kills++; } });
  await assert.rejects(result);
  children[0]!.emit("close", 0, null);
  children[0]!.emit("error", new Error("late"));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(kills, 1);
});

test("a child that exits 0 resolves with its stdout and never reaches the kill", async () => {
  const { spawn, children } = fakeSpawner();
  let kills = 0;
  const result = execBounded("x", [], { timeoutMs: 5000, spawn, killTree: () => { kills++; } });
  children[0]!.stdout.write("42\n");
  children[0]!.emit("close", 0, null);
  assert.equal(await result, "42\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(kills, 0);
});

test("a non-zero exit rejects with its code and stderr, not as a timeout", async () => {
  const { spawn, children } = fakeSpawner();
  const result = execBounded("x", [], { timeoutMs: 5000, spawn, killTree: () => {} });
  children[0]!.stderr.write("boom");
  children[0]!.emit("close", 3, null);
  await assert.rejects(result, (error: { code?: unknown; timedOut?: boolean; stderr?: string }) => error.code === 3 && !error.timedOut && error.stderr === "boom");
});

test("a spawn error and a thrown spawn both reject", async () => {
  const { spawn, children } = fakeSpawner();
  const result = execBounded("missing", [], { timeoutMs: 5000, spawn });
  children[0]!.emit("error", Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" }));
  await assert.rejects(result, /ENOENT/);
  await assert.rejects(execBounded("x", [], { timeoutMs: 5000, spawn: () => { throw new Error("EMFILE"); } }), /EMFILE/);
});

test("output past maxBuffer ends the call and the tree", async () => {
  const { spawn, children } = fakeSpawner();
  let kills = 0;
  const result = execBounded("x", [], { timeoutMs: 5000, maxBuffer: 4, spawn, killTree: () => { kills++; } });
  children[0]!.stdout.write("too much output");
  await assert.rejects(result, /more than 4 bytes/);
  assert.equal(kills, 1);
});

test("on Windows the tree is killed with taskkill /T /F, detached, and not waited for", () => {
  const { spawn, calls } = fakeSpawner();
  const child = new FakeChild();
  killProcessTree(child as unknown as BoundedChild, "win32", spawn);
  assert.deepEqual(calls.map(c => [c.file, c.args.join(" "), c.detached]), [["taskkill", "/PID 4242 /T /F", true]]);
  assert.deepEqual(child.killed, [], "taskkill took the child with it");
});

test("on Windows a taskkill that cannot start falls back to killing the child", () => {
  const child = new FakeChild();
  const killer = new EventEmitter();
  killProcessTree(child as unknown as BoundedChild, "win32", () => killer as unknown as BoundedChild);
  killer.emit("error", new Error("ENOENT"));
  assert.deepEqual(child.killed, ["SIGKILL"]);
});

test("Windows spawns no process group, POSIX does", async () => {
  for (const [platform, detached] of [["win32", false], ["linux", true]] as const) {
    const { spawn, children, calls } = fakeSpawner();
    const result = execBounded("x", [], { timeoutMs: 5000, platform, spawn });
    children[0]!.emit("close", 0, null);
    await result;
    assert.equal(calls[0]!.detached, detached);
  }
});

// The real thing, with a real grandchild that keeps the pipes open after its parent is killed.
test("a real command whose grandchild holds the pipes is cut at the deadline", { skip: process.platform === "win32" }, async () => {
  const script = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)";
  const started = Date.now();
  await assert.rejects(execBounded(process.execPath, ["-e", script], { timeoutMs: 400 }), (error: { timedOut?: boolean }) => error.timedOut === true);
  assert.ok(Date.now() - started < 2500);
});

test("a real command that finishes is read whole", async () => {
  const out = await execBounded(process.execPath, ["-e", "process.stdout.write('hello')"], { timeoutMs: 10_000 });
  assert.equal(out, "hello");
});
