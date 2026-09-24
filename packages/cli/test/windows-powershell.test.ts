import { test } from "node:test";
import assert from "node:assert/strict";
import { windowsPowerShellEnv } from "../src/windows-powershell.ts";

// From a PowerShell 7 terminal, an inherited PSModulePath made powershell.exe load the pwsh copy of
// Microsoft.PowerShell.Security and lose the Cert: drive (issue #35).
test("powershell.exe is started without an inherited PSModulePath, in any case, and nothing else is dropped", () => {
  const keys = ["PSModulePath", "PSMODULEPATH", "CR_TEST_KEEP"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.PSModulePath = "C:\\Program Files\\PowerShell\\Modules";
    process.env.PSMODULEPATH = "C:\\Program Files\\PowerShell\\Modules";
    process.env.CR_TEST_KEEP = "1";
    const env = windowsPowerShellEnv();
    assert.equal(Object.keys(env).some((k) => k.toLowerCase() === "psmodulepath"), false);
    assert.equal(env.CR_TEST_KEEP, "1");
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
