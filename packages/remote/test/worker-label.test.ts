import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPinnedModelId, workerModelLabel } from "../web/worker-label.ts";
import { setWorkerAccounts, workerLabelFor } from "../src/worker-labels.ts";
import { EventLog } from "../src/eventlog.ts";
import { RouterClient } from "../src/router.ts";
import { BackgroundActivity } from "../src/background-activity.ts";
import { effortOf } from "../src/desktop.ts";

const ACCOUNTS = { "anthropic#f952fac6": "mambo20211" };

test("a pinned id reads as the model's short title and the account, never the pin", () => {
  assert.equal(workerModelLabel("anthropic#f952fac6:claude-opus-5-5", ACCOUNTS), "Opus 5.5 · mambo20211");
  assert.equal(workerModelLabel("anthropic#f952fac6:claude-haiku-5-5@high", ACCOUNTS), "Haiku 5.5 · mambo20211");
  assert.equal(workerModelLabel("anthropic#f952fac6:claude-sonnet-5-5-20261001", ACCOUNTS), "Sonnet 5.5 · mambo20211");
});

test("an unknown account is left out and the pin is not shown", () => {
  assert.equal(workerModelLabel("anthropic#f952fac6:claude-opus-5-5"), "Opus 5.5");
  assert.equal(workerModelLabel("anthropic#deadbeef:claude-opus-5-5@high", ACCOUNTS), "Opus 5.5");
  assert.equal(workerModelLabel("chatgpt#abc12345:gpt-6.1-sol", {}), "gpt-6.1-sol");
});

test("unpinned ids and empty values stay as they are", () => {
  assert.equal(workerModelLabel("deepseek-v4.1-flash", ACCOUNTS), "deepseek-v4.1-flash");
  assert.equal(workerModelLabel("qwen3:8b", ACCOUNTS), "qwen3:8b");
  assert.equal(workerModelLabel(null), undefined);
  assert.equal(workerModelLabel(""), undefined);
  assert.equal(isPinnedModelId("anthropic#f952fac6:claude-opus-5-5"), true);
  assert.equal(isPinnedModelId("claude-opus-5-5"), false);
});

test("the host labels a pinned worker's event and leaves another model alone", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ripple-worker-label-"));
  const log = EventLog.open({ dir, now: () => 1 });
  t.after(() => { log.close(); setWorkerAccounts({}); rmSync(dir, { recursive: true, force: true }); });
  setWorkerAccounts(ACCOUNTS);
  const body = { kind: "subagent" as const, toolUseId: "t1", sub: "sub-t1", description: "x", status: "running" as const, steps: 0 };
  const pinned = log.append({ ...body, model: "anthropic#f952fac6:claude-opus-5-5" });
  assert.equal(pinned.kind === "subagent" && pinned.model, "anthropic#f952fac6:claude-opus-5-5", "model itself is unchanged");
  assert.equal(pinned.kind === "subagent" && pinned.modelLabel, "Opus 5.5 · mambo20211");
  const plain = log.append({ ...body, model: "deepseek-v4.1-flash" });
  assert.equal(plain.kind === "subagent" && plain.modelLabel, undefined);
  assert.equal(workerLabelFor(null), undefined);
});

test("the background-task row carries the label from the worker event", () => {
  const activity = new BackgroundActivity();
  activity.accept({ kind: "subagent", toolUseId: "t1", sub: "sub-t1", description: "x", model: "anthropic#f952fac6:claude-opus-5-5", modelLabel: "Opus 5.5 · mambo20211", status: "running", steps: 0 }, (x) => String(x));
  const row = activity.active.find((task) => task.sub === "sub-t1");
  assert.equal(row?.model, "anthropic#f952fac6:claude-opus-5-5");
  assert.equal(row?.modelLabel, "Opus 5.5 · mambo20211");
});

test("account names come from the router's worker files by provider and pin", async () => {
  const body = { models: [], providers: [], agents: [
    { name: "a", provider: "anthropic", account: "mambo20211", accountPin: "f952fac6" },
    { name: "b", provider: "anthropic" },
  ] };
  const client = new RouterClient("http://x", async () => ({ ok: true, status: 200, json: async () => body }));
  assert.deepEqual(await client.workerAccounts(), ACCOUNTS);
});

test("an account in the title is never read as the worker's effort", () => {
  assert.equal(effortOf("anthropic#f952fac6:claude-opus-5-5", "Opus5.5·Work-account · Review parser"), "");
  assert.equal(effortOf("anthropic#f952fac6:claude-opus-5-5", "Opus5.5·Work-account·high · Review parser"), "high");
  assert.equal(effortOf("anthropic#f952fac6:claude-opus-5-5", "Opus5.5·업무-개인·max · Review parser"), "max");
  assert.equal(effortOf("gpt-6.1-sol", "Sol·medium · Fix"), "medium");
  assert.equal(effortOf("gpt-6.1-sol@low", "Sol·Work · Fix"), "low", "the model's own @effort wins");
});
