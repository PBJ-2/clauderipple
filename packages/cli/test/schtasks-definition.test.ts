import { test } from "node:test";
import assert from "node:assert/strict";
import { taskDefinitionMatches } from "../src/schtasks.ts";

const expected = { arguments: '-NoProfile -File "C:\\Users\\me\\.clauderipple\\router.ps1"', userId: "me" };
const valid = { actionCount: 1, execute: "powershell.exe", arguments: expected.arguments, userId: "ME", runLevel: 0 };

test("accepts only the expected limited per-user task", () => {
  assert.equal(taskDefinitionMatches(valid, expected), true);
  assert.equal(taskDefinitionMatches(null, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, actionCount: 2 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, execute: "cmd.exe" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, arguments: "-File foreign.ps1" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "other" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, runLevel: 1 }, expected), false);
});
