import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, gitInfo, worktreeSlug } from "../src/worktree.ts";
import { makeFolder } from "../src/folders.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function tmp(t: TestContext, name: string): string {
  // Git reports the native long form on Windows even when TEMP uses an 8.3 alias.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ripple-creation-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, name);
  fs.mkdirSync(target);
  return target;
}

/** A real one-commit git repository named `myproject`, on branch `main`. */
function repo(t: TestContext): { dir: string; root: string } {
  const dir = tmp(t, "myproject");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Ripple Test");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, root: fs.realpathSync.native(dir) };
}

test("worktreeSlug makes a branch-safe name, empty for nothing usable", () => {
  assert.equal(worktreeSlug("Add a big Feature!"), "add-a-big-feature");
  assert.equal(worktreeSlug("   "), "");
  assert.equal(worktreeSlug("한글 텍스트"), "");
  assert.ok(worktreeSlug("x".repeat(200)).length <= 40);
});

test("gitInfo reads the repo, its current branch and its local branches", async t => {
  const { dir, root } = repo(t);
  git(dir, "branch", "dev");
  const info = await gitInfo(dir);
  assert.equal(info.isRepo, true);
  assert.equal(fs.realpathSync.native(info.root!), root);
  assert.equal(info.branch, "main");
  assert.deepEqual(info.branches, ["dev", "main"]);
  // A plain folder is not a repo, and asking never throws.
  assert.deepEqual(await gitInfo(tmp(t, "plain")), { isRepo: false, root: null, branch: null, branches: [] });
});

test("createWorktree makes <repo>-worktrees/<slug> on a new branch, leaving the picked folder alone", async t => {
  const { dir, root } = repo(t);
  const before = git(dir, "rev-parse", "HEAD");
  const made = await createWorktree({ cwd: dir, text: "Add a search feature" });
  assert.equal(made.branch, "add-a-search-feature");
  assert.equal(made.base, "main");
  assert.equal(path.basename(made.dir), "add-a-search-feature");
  assert.equal(path.basename(path.dirname(made.dir)), "myproject-worktrees");
  assert.equal(path.dirname(path.dirname(made.dir)), path.dirname(root));
  assert.ok(fs.statSync(made.dir).isDirectory());
  // The new worktree is on its own branch, at the base commit.
  assert.equal(git(made.dir, "rev-parse", "--abbrev-ref", "HEAD"), "add-a-search-feature");
  assert.equal(git(made.dir, "rev-parse", "HEAD"), before);
  // The person's checkout is untouched.
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.ok(git(dir, "worktree", "list").includes("add-a-search-feature"));
});

test("createWorktree branches from a chosen base branch", async t => {
  const { dir } = repo(t);
  git(dir, "checkout", "-q", "-b", "dev");
  fs.writeFileSync(path.join(dir, "dev.txt"), "dev\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "dev work");
  const devHead = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  const made = await createWorktree({ cwd: dir, text: "From dev", baseBranch: "dev" });
  assert.equal(made.base, "dev");
  assert.equal(git(made.dir, "rev-parse", "HEAD"), devHead);
});

test("createWorktree refuses a non-git folder, an unknown base and an existing target", async t => {
  await assert.rejects(createWorktree({ cwd: tmp(t, "plain"), text: "x" }), /git repository/i);
  const { dir } = repo(t);
  await assert.rejects(createWorktree({ cwd: dir, text: "x", baseBranch: "nope" }), /base branch/i);
  await createWorktree({ cwd: dir, text: "twice" });
  await assert.rejects(createWorktree({ cwd: dir, text: "twice" }), /already exists/i);
});

test("makeFolder makes one level under the parent and validates the name", async t => {
  const parent = tmp(t, "parent");
  const made = await makeFolder(parent, "child");
  assert.equal(made, path.join(parent, "child"));
  assert.ok(fs.statSync(made).isDirectory());
  await assert.rejects(makeFolder(parent, "child"), /EEXIST/);
  await assert.rejects(makeFolder(parent, "a/b"), /Invalid folder name/);
  await assert.rejects(makeFolder(parent, ".."), /Invalid folder name/);
  await assert.rejects(makeFolder(parent, "   "), /Invalid folder name/);
  await assert.rejects(makeFolder(path.join(parent, "gone"), "x"), /can't be opened/);
});
