import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const originalExecPath = process.execPath;
const originalArgv1 = process.argv[1];
const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
const hadResourcesPath = Object.hasOwn(processWithResources, "resourcesPath");
const originalResourcesPath = processWithResources.resourcesPath;

test("runtime uses packaged Electron executable and bundled sources", async () => {
  process.execPath = "/Applications/ClaudeRipple.app/Contents/MacOS/ClaudeRipple";
  processWithResources.resourcesPath = "/Applications/ClaudeRipple.app/Contents/Resources";
  try {
    const { runtime } = await import("../src/runtime.ts");
    const value = runtime();
    assert.equal(value.packaged, true);
    assert.equal(value.node, "/Applications/ClaudeRipple.app/Contents/MacOS/ClaudeRipple");
    assert.deepEqual(value.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(value.cli, "/Applications/ClaudeRipple.app/Contents/Resources/clauderipple/packages/cli/src/index.ts");
    assert.equal(value.router, "/Applications/ClaudeRipple.app/Contents/Resources/clauderipple/packages/router/src/index.ts");
  } finally {
    process.execPath = originalExecPath;
    if (originalArgv1 === undefined) delete process.argv[1];
    else process.argv[1] = originalArgv1;
    if (hadResourcesPath) processWithResources.resourcesPath = originalResourcesPath!;
    else delete processWithResources.resourcesPath;
  }
});

// Two unpackaged layouts run the same code: the checkout's TypeScript and the JavaScript an npm
// install carries, one level down in the same shape. Node refuses to strip types under
// node_modules, so the published package cannot be the .ts sources — and every path derived here
// has to land on a file that exists, or the CLI installs a router that cannot start.
test("outside a packaged app the runtime points at files that exist, in this layout's extension", async () => {
  const { runtime } = await import("../src/runtime.ts");
  const value = runtime();
  assert.equal(value.packaged, false);
  assert.equal(value.node, process.execPath);
  for (const file of [value.cli, value.router, value.hookScript]) {
    assert.match(file, /\.ts$/, `the checkout runs TypeScript: ${file}`);
    assert.ok(fs.existsSync(file), `${file} exists`);
  }
  assert.equal(value.repo, path.resolve(import.meta.dirname, "../../.."));
  assert.equal(value.trayMain, path.join(value.repo, "packages", "app", "dist", "main.js"));
  // The dashboard the router serves is found by the same relative walk, from the router's own file.
  assert.ok(fs.existsSync(path.resolve(path.dirname(value.router), "../../ui/index.html")), "the dashboard sits next to the router");
});
