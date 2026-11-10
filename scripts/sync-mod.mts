#!/usr/bin/env node
// Keeps the copy of the status mod that everyday sessions load (~/.clauderipple/mod) at the last
// commit on main, so a session editing packages/mod does not reload every open session on each save.
//
// Sessions load the mod from CLAUDE_CODE_PLUGIN_DIRS and, with CLAUDE_CODE_PLUGIN_DIR_WATCH=1,
// reload it whenever its folder changes, each reload leaving a "ripple reloaded (N hooks: …)" line in
// every open transcript (seen 2026-10-13 while another session redrew the band). Pointing that
// variable here instead of at the checkout makes a reload happen once per commit, and never on
// work in progress.
//
// Usage: node scripts/sync-mod.mts            from the git hooks: only on main; writes only files that differ, so a commit
//                                             that leaves packages/mod alone touches nothing and reloads nothing
//        node scripts/sync-mod.mts --force    copy HEAD's packages/mod now, whatever the branch
//        node scripts/sync-mod.mts --install  write the post-commit, post-merge and post-rewrite hooks, then --force

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(os.homedir(), ".clauderipple", "mod");
const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** What the engine writes into a plugin folder it loads; never part of the commit, never removed. */
const engineOwned = (rel: string): boolean => rel === ".claude-plugin/types" || rel.startsWith(".claude-plugin/types/");

function install(): void {
  const hooks = path.resolve(root, git("rev-parse", "--git-common-dir").trim(), "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of ["post-commit", "post-merge", "post-rewrite"]) {
    const file = path.join(hooks, name);
    if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").includes("sync-mod.mts")) throw new Error(`${file} exists and is not ours; add a call to scripts/sync-mod.mts by hand`);
    // In the background: a commit never waits on the copy, and a failed copy never fails a commit.
    fs.writeFileSync(file, `#!/bin/sh\n# ClaudeRipple: copy packages/mod to ~/.clauderipple/mod (scripts/sync-mod.mts)\nnode "$(git rev-parse --show-toplevel)/scripts/sync-mod.mts" >/dev/null 2>&1 &\n`, { mode: 0o755 });
  }
}

/** HEAD's packages/mod, path relative to it → contents, from git (never the working tree). */
function committed(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const rel of git("ls-tree", "-r", "--name-only", "-z", "HEAD", "--", "packages/mod").split("\0").filter(Boolean)) {
    files.set(rel.slice("packages/mod/".length), execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
  }
  return files;
}

/** Writes only what differs and removes what HEAD no longer has, in place: the watcher keeps its folder. */
function sync(files: Map<string, Buffer>, staging: string): number {
  const next = path.join(staging, "next");
  let changed = 0;
  for (const [rel, body] of files) {
    const file = path.join(dest, rel);
    let same = false;
    try { same = fs.readFileSync(file).equals(body); } catch { /* new file */ }
    if (same) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(next, body);
    fs.renameSync(next, file);
    changed++;
  }
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(dest, file).split(path.sep).join("/");
      if (engineOwned(rel)) continue;
      if (entry.isDirectory()) { walk(file); if (!fs.readdirSync(file).length) fs.rmdirSync(file); }
      else if (!files.has(rel)) { fs.rmSync(file); changed++; }
    }
  };
  walk(dest);
  return changed;
}

const args = new Set(process.argv.slice(2));
if (args.has("--install")) install();
const force = args.has("--force") || args.has("--install");
// A merge or rebase may bring several commits at once; comparing with the copy itself never misses one.
if (!force && git("rev-parse", "--abbrev-ref", "HEAD").trim() !== "main") process.exit(0);
fs.mkdirSync(dest, { recursive: true });
const files = committed();
// A sibling stays outside the watched tree and another sync's obsolete-file cleanup.
const staging = fs.mkdtempSync(`${dest}.next-`);
try {
  const changed = sync(files, staging);
  console.log(`sync-mod: ${changed} file(s) updated in ${dest}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
