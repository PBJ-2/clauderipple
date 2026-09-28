import { test } from "node:test";
import assert from "node:assert/strict";
import { taskDefinitionMatches, taskUser } from "../src/schtasks.ts";

const expected = { arguments: '-NoProfile -File "C:\\Users\\me\\.clauderipple\\router.ps1"', userId: "me" };
const valid = {
  actionCount: 1,
  execute: "powershell.exe",
  arguments: expected.arguments,
  userId: "ME",
  runLevel: 0,
  logonType: 3,
  triggerCount: 1,
  triggerType: "MSFT_TaskLogonTrigger",
  triggerUserId: "me",
  restartCount: 99,
  restartInterval: "PT1M",
  executionTimeLimit: "PT0S",
  multipleInstances: 2,
  allowStartIfOnBatteries: true,
  dontStopIfGoingOnBatteries: true,
};

test("accepts only the expected limited per-user task", () => {
  assert.equal(taskDefinitionMatches(valid, expected), true);
  assert.equal(taskDefinitionMatches(null, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, actionCount: 2 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, execute: "cmd.exe" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, arguments: "-File foreign.ps1" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "other" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, runLevel: 1 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, logonType: 0 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, triggerCount: 2 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, triggerType: "MSFT_TaskDailyTrigger" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, triggerUserId: "other" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, restartCount: 0 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, restartInterval: "PT5M" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, executionTimeLimit: "PT72H" }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, multipleInstances: 0 }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, allowStartIfOnBatteries: false }, expected), false);
  assert.equal(taskDefinitionMatches({ ...valid, dontStopIfGoingOnBatteries: false }, expected), false);
});

// #38: a local account named after its computer does not resolve by its bare name, so the task is
// registered as HOST\user — and Windows then stores the principal bare and the trigger qualified.
test("the task user is domain-qualified, and either spelling of it matches", () => {
  assert.equal(taskUser("x", "X"), "X\\x");
  assert.equal(taskUser("x", ""), "x");

  const qualified = { ...expected, userId: "X\\x" };
  assert.equal(taskDefinitionMatches({ ...valid, userId: "x", triggerUserId: "X\\x" }, qualified), true);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "x", triggerUserId: "x" }, qualified), true);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "Y\\x", triggerUserId: "X\\x" }, qualified), false);
  assert.equal(taskDefinitionMatches({ ...valid, userId: "x", triggerUserId: "X\\other" }, qualified), false);
});
