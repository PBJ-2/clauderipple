import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config.ts";

// config.json holds provider API keys. A file written before PR #134, or replaced by an editor under
// a 022 umask, can sit at 0644 until its next save, so every load tightens it. POSIX modes only:
// Windows has no owner-only file mode, the same skip the other mode tests use.

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

test("the router tightens an existing 0644 config.json to owner-only when it loads it", { skip: process.platform === "win32" }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-config-mode-"));
  const previousHome = process.env.CLAUDERIPPLE_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify({ listen: { port: 4321 } }));
  fs.chmodSync(file, 0o644);
  assert.equal(mode(file), 0o644);

  process.env.CLAUDERIPPLE_HOME = home;
  const store = new ConfigStore(); // the router's own load, through the default config path
  assert.equal(store.get().listen.port, 4321);
  assert.equal(mode(file), 0o600);
});

test("a config.json made group- or world-readable while the router runs is tightened on the next read", { skip: process.platform === "win32" }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-config-mode-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify({ listen: { port: 4321 } }));
  fs.chmodSync(file, 0o600);
  const store = new ConfigStore(file);
  // Same content and mtime as the load above: only the per-request read can see the new mode.
  fs.chmodSync(file, 0o644);
  assert.equal(store.get().listen.port, 4321);
  assert.equal(mode(file), 0o600);
});
