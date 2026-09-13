import { test } from "node:test";
import assert from "node:assert/strict";
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
