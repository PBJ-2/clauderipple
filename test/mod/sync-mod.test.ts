import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const script = path.resolve(import.meta.dirname, "../../scripts/sync-mod.mts");

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-mod-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const dest = path.join(home, ".clauderipple", "mod");
  fs.mkdirSync(dest, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, "no-global-config"),
  };
  const git = (repo: string, ...args: string[]) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", ...args,
  ], { cwd: repo, env, stdio: "pipe" });
  const repo = (name: string, body: string) => {
    const root = path.join(dir, name);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.copyFileSync(script, path.join(root, "scripts", "sync-mod.mts"));
    fs.mkdirSync(path.join(root, "packages", "mod", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "mod", "nested", "mod.js"), body);
    git(root, "-c", "init.templateDir=", "init", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-m", "Fixture");
    return root;
  };
  const preload = path.join(dir, "pause-rename.cjs");
  fs.writeFileSync(preload, `
const fs = require("node:fs");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  process.stdout.write(JSON.stringify({ staged: from }) + "\\n");
  fs.readSync(0, Buffer.alloc(1), 0, 1, null);
  if (process.env.FAIL_RENAME) throw new Error("injected rename failure");
  return rename(from, to);
};
`);
  const start = (root: string, fail = false) => {
    const child = spawn(process.execPath, ["--require", preload, "scripts/sync-mod.mts", "--force"], {
      cwd: root, env: { ...env, ...(fail ? { FAIL_RENAME: "1" } : {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "";
    let stderr = "";
    const staged = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", chunk => {
        stdout += String(chunk);
        const line = stdout.split("\n")[0]!;
        if (stdout.includes("\n")) resolve((JSON.parse(line) as { staged: string }).staged);
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Exited before staging: ${code}: ${stderr}`)));
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exited = once(child, "exit");
    return {
      staged,
      async release() {
        child.stdin.end("\n");
        const [code] = await exited;
        return { code, stdout, stderr };
      },
    };
  };
  return { dir, home, dest, env, repo, start };
}

test("parallel syncs keep their own staging through another sync's cleanup", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const firstRepo = f.repo("first", "first committed version\n");
  const secondRepo = f.repo("second", "second committed version\n");
  // Working-tree edits must not leak into the synchronized copy.
  fs.writeFileSync(path.join(firstRepo, "packages/mod/nested/mod.js"), "uncommitted\n");
  const types = path.join(f.dest, ".claude-plugin", "types");
  fs.mkdirSync(types, { recursive: true });
  fs.writeFileSync(path.join(types, "engine.d.ts"), "engine owned\n");
  fs.writeFileSync(path.join(f.dest, "obsolete.js"), "obsolete\n");
  const first = f.start(firstRepo);
  const firstStage = await first.staged;
  const second = f.start(secondRepo);
  const secondStage = await second.staged;
  assert.ok(fs.existsSync(firstStage));
  assert.ok(fs.existsSync(secondStage));
  const firstResult = await first.release();
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(fs.readFileSync(path.join(f.dest, "nested/mod.js"), "utf8"), "first committed version\n");
  assert.ok(fs.existsSync(secondStage), "first sync must not remove the second sync's staging");
  const secondResult = await second.release();
  assert.equal(secondResult.code, 0, secondResult.stderr);
  assert.notEqual(firstStage, secondStage);
  assert.equal(fs.readFileSync(path.join(f.dest, "nested/mod.js"), "utf8"), "second committed version\n");
  assert.equal(fs.readFileSync(path.join(types, "engine.d.ts"), "utf8"), "engine owned\n");
  assert.equal(fs.existsSync(path.join(f.dest, "obsolete.js")), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.dest)), ["mod"]);
  assert.deepEqual(fs.readdirSync(path.join(f.dest, "nested")), ["mod.js"]);

  const file = path.join(f.dest, "nested/mod.js");
  fs.utimesSync(file, new Date(0), new Date(0));
  const unchanged = execFileSync(process.execPath, ["scripts/sync-mod.mts"], { cwd: secondRepo, env: f.env, encoding: "utf8" });
  assert.match(unchanged, /0 file\(s\) updated/);
  assert.equal(fs.statSync(file).mtimeMs, 0, "unchanged files must not be rewritten");
});

test("a symlink destination stages beside its real directory", { timeout: 15_000, skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  const root = f.repo("repo", "committed through symlink\n");
  const target = path.join(f.dir, "volume", "mod");
  fs.mkdirSync(target, { recursive: true });
  fs.rmdirSync(f.dest);
  fs.symlinkSync(target, f.dest, "dir");
  const child = f.start(root);
  const staged = await child.staged;
  const result = await child.release();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(path.dirname(path.dirname(staged)), fs.realpathSync(path.dirname(target)), "staging must use the target's filesystem, not the symlink's lexical parent");
  assert.equal(fs.lstatSync(f.dest).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(target, "nested/mod.js"), "utf8"), "committed through symlink\n");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["mod"]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.dest)), ["mod"]);
});

test("a failed rename cleans only that invocation's staging", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const root = f.repo("repo", "committed\n");
  fs.mkdirSync(path.join(f.dest, "nested"));
  fs.writeFileSync(path.join(f.dest, "nested/mod.js"), "previous\n");
  const otherStage = path.join(path.dirname(f.dest), "mod.next-other");
  fs.mkdirSync(otherStage);
  fs.writeFileSync(path.join(otherStage, "keep"), "other sync\n");
  const child = f.start(root, true);
  const staged = await child.staged;
  assert.ok(fs.existsSync(staged));
  const result = await child.release();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /injected rename failure/);
  assert.equal(fs.existsSync(staged), false, "failed staging must be removed");
  assert.deepEqual(fs.readdirSync(path.dirname(f.dest)).sort(), ["mod", "mod.next-other"]);
  assert.equal(fs.readFileSync(path.join(otherStage, "keep"), "utf8"), "other sync\n");
  assert.equal(fs.readFileSync(path.join(f.dest, "nested/mod.js"), "utf8"), "previous\n");
});
