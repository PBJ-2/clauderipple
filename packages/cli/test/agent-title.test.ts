import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { retitle, claudePretty, fromMarker } from "../src/hooks/agent-title.ts";
import { setAgentTitleHook, agentTitleHookEnabled } from "../src/settings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = { names: { "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol" } };

test("marker wins, agent file next, claude alias otherwise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-agents-"));
  fs.writeFileSync(path.join(dir, "gpt.md"), "---\nname: gpt\nmodel: gpt-5.6-terra@high\n---\nbody\n");
  const base = { tool_name: "Agent", effort: { level: "medium" } };
  assert.equal(retitle({ ...base, tool_input: { description: "Do X", prompt: "[[gpt: sol@xhigh]]\nhi", subagent_type: "gpt" } }, [dir], NAMES)!.description, "Sol·xhigh · Do X");
  assert.equal(retitle({ ...base, tool_input: { description: "Do X", prompt: "[[ripple: gpt@low]]\nhi", subagent_type: "gpt" } }, [dir], NAMES)!.description, "Terra·low · Do X", "ripple marker naming an agent");
  assert.equal(retitle({ ...base, tool_input: { description: "Do X", prompt: "hi\n[[ripple: gpt@low]]", subagent_type: "gpt" } }, [dir], NAMES)!.description, "Terra·high · Do X", "a marker below the top is prose, as in the router");
  assert.equal(retitle({ ...base, tool_input: { description: "Do X", prompt: "hi", subagent_type: "gpt" } }, [dir], NAMES)!.description, "Terra·high · Do X");
  assert.equal(retitle({ ...base, tool_input: { description: "Do X", prompt: "hi", subagent_type: "Explore", model: "sonnet" } }, [dir], NAMES)!.description, "Sonnet·medium · Do X");
  assert.equal(retitle({ ...base, tool_input: { description: "Terra·high · Do X", prompt: "hi", subagent_type: "gpt" } }, [dir], NAMES), null, "already prefixed");
  assert.equal(retitle({ ...base, tool_input: { description: "Sol·low · Do X", prompt: "hi", subagent_type: "gpt" } }, [dir], NAMES)!.description, "Terra·high · Do X", "stale prefix replaced");
  assert.equal(retitle({ tool_name: "Bash", tool_input: { description: "x" } }, [dir], NAMES), null);
  assert.equal(claudePretty("claude-haiku-4-5-20251001"), "Haiku4.5");
  assert.deepEqual(fromMarker("<system-reminder>r</system-reminder>\n[[ripple: Luna@max]]\nx"), { name: "luna", effort: "max" });
  assert.equal(fromMarker("x\n[[ripple: luna@max]]"), null);
});

test("routed models: any id, the marker's level over the file's, clamped as the router does", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-agents-"));
  fs.writeFileSync(path.join(dir, "deepseek-v4-1-flash.md"), "---\nname: deepseek-v4-1-flash\nmodel: deepseek-v4.1-flash@medium\n---\nbody\n");
  fs.writeFileSync(path.join(dir, "gpt-6-astra.md"), "---\nname: gpt-6-astra\nmodel: gpt-6-astra@medium\n---\nbody\n");
  const cfg = { names: { "gpt-6-astra": "Astra", "deepseek-v4.1-flash": "deepseek-v4.1-flash" }, aliases: { astra: "gpt-6-astra" }, effortClamp: { ultra: "max" } };
  const call = (prompt: string, description = "Do X", subagent_type = "deepseek-v4-1-flash") =>
    retitle({ tool_name: "Agent", effort: { level: "xhigh" }, tool_input: { description, prompt, subagent_type } }, [dir], cfg)?.description;
  assert.equal(call("hi"), "deepseek-v4.1-flash·medium · Do X");
  assert.equal(call("[[ripple: deepseek-v4-1-flash@high]]\nhi"), "deepseek-v4.1-flash·high · Do X");
  assert.equal(call("[[ripple: astra@ultra]]\nhi"), "Astra·max · Do X", "alias, and ultra clamped to max");
  assert.equal(call("[[ripple: gpt-6-astra]]\nhi", "Astra·low · Do X", "gpt-6-astra"), "Astra·medium · Do X", "the parent's own prefix is corrected");
});

test("hook script: stdin → updatedInput JSON, garbage → silence", () => {
  const script = path.resolve(here, "../src/hooks/agent-title.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-home-"));
  const input = JSON.stringify({ tool_name: "Agent", tool_input: { description: "Review", prompt: "[[gpt: terra@high]]\ngo" }, effort: { level: "high" } });
  const out = execFileSync(process.execPath, [script], { input, env: { ...process.env, CLAUDERIPPLE_HOME: home } }).toString();
  assert.equal(JSON.parse(out).hookSpecificOutput.updatedInput.description, "Terra·high · Review");
  assert.equal(execFileSync(process.execPath, [script], { input: "not json", env: { ...process.env, CLAUDERIPPLE_HOME: home } }).toString(), "");
});

test("settings: hook entry added/removed by marker only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo" }] }] } }));
  process.env.CLAUDE_SETTINGS_PATH = file;
  try {
    assert.equal(agentTitleHookEnabled(), false);
    assert.equal(setAgentTitleHook(true, { node: "/n", env: { ELECTRON_RUN_AS_NODE: "1" }, script: "/s.ts" }).changed, true);
    assert.equal(agentTitleHookEnabled(), true);
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(s.hooks.PreToolUse[0].matcher, "*", "foreign entry untouched");
    assert.equal(s.hooks.PreToolUse[1].hooks[0].command, "ELECTRON_RUN_AS_NODE=1 \"/n\" \"/s.ts\"");
    assert.equal(setAgentTitleHook(true, { node: "/n", env: { ELECTRON_RUN_AS_NODE: "1" }, script: "/s.ts" }).changed, false, "idempotent");
    assert.equal(setAgentTitleHook(false, { node: "/n", script: "/s.ts" }).changed, true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hooks.PreToolUse.length, 1);
  } finally {
    delete process.env.CLAUDE_SETTINGS_PATH;
  }
});
