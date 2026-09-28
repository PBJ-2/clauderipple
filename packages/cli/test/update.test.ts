import { test } from "node:test";
import assert from "node:assert/strict";
import { installKind, isNewer } from "../src/update.ts";

test("versions compare by number, not as text", () => {
  assert.equal(isNewer("0.6.0", "0.5.1"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.5.1", "0.5.1"), false);
  assert.equal(isNewer("0.5.0", "0.5.1"), false);
  assert.equal(isNewer("v1.0.0", "0.9.0"), true);
});

// The install scripts and `npm install -g` put the package in the same layout; only the prefix
// says which one did, and each must be updated its own way (update.ts).
test("an install is recognised by where its files are", () => {
  const home = "/Users/me";
  const js = (repo: string) => ({ packaged: false, cli: `${repo}/dist/cli/src/index.js`, repo });
  assert.deepEqual(installKind(js("/Users/me/.clauderipple/lib/node_modules/clauderipple"), { platform: "darwin", env: {}, home }), { kind: "script", prefix: "/Users/me/.clauderipple" });
  assert.deepEqual(installKind(js("/opt/homebrew/lib/node_modules/clauderipple"), { platform: "darwin", env: {}, home }), { kind: "npm", prefix: "/opt/homebrew" });
  assert.deepEqual(installKind(js("/srv/cr/lib/node_modules/clauderipple"), { platform: "linux", env: { CLAUDERIPPLE_PREFIX: "/srv/cr" }, home }), { kind: "script", prefix: "/srv/cr" });
  assert.equal(installKind(js("/Users/me/project/node_modules/clauderipple"), { platform: "darwin", env: {}, home }).kind, "unknown");
  assert.equal(installKind({ packaged: false, cli: "/Users/me/src/ClaudeRipple/packages/cli/src/index.ts", repo: "/Users/me/src/ClaudeRipple" }, { platform: "darwin", env: {}, home }).kind, "checkout");
  assert.equal(installKind({ packaged: true, cli: "x", repo: "y" }).kind, "packaged");

  const win = { packaged: false, cli: "C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple\\dist\\cli\\src\\index.js", repo: "C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple" };
  assert.deepEqual(installKind(win, { platform: "win32", env: {}, home: "C:\\Users\\ME" }), { kind: "script", prefix: "C:\\Users\\me\\.clauderipple" });
  assert.equal(installKind({ ...win, repo: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\clauderipple" }, { platform: "win32", env: {}, home: "C:\\Users\\me" }).kind, "npm");
});
