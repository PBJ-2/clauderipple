import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-settings-"));
process.env.CLAUDE_SETTINGS_PATH = path.join(dir, "settings.json");
const { applyProxyEnv, removeProxyEnv, currentProxyEnv } = await import("../src/settings.ts");

test("applyProxyEnv adds keys, backs up, preserves other settings; remove restores", () => {
  const file = process.env.CLAUDE_SETTINGS_PATH!;
  fs.writeFileSync(file, JSON.stringify({ model: "opus", env: { FOO: "1" }, permissions: { allow: ["Bash"] } }));
  const e1 = applyProxyEnv({ proxyUrl: "http://127.0.0.1:8790", caPath: "/x/ca.pem", force: false });
  assert.equal(e1.changed, true);
  assert.ok(e1.backup && fs.existsSync(e1.backup));
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(s.env.FOO, "1");
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions, { allow: ["Bash"] });
  assert.deepEqual(currentProxyEnv(), { HTTPS_PROXY: "http://127.0.0.1:8790", NODE_EXTRA_CA_CERTS: "/x/ca.pem" });

  const e2 = applyProxyEnv({ proxyUrl: "http://127.0.0.1:8790", caPath: "/x/ca.pem", force: false });
  assert.equal(e2.changed, false);

  assert.throws(() => applyProxyEnv({ proxyUrl: "http://127.0.0.1:9999", caPath: "/x/ca.pem", force: false }), /already/);
  const e3 = applyProxyEnv({ proxyUrl: "http://127.0.0.1:9999", caPath: "/x/ca.pem", force: true });
  assert.equal(e3.notes.length, 1);

  const r = removeProxyEnv({ proxyUrl: "http://127.0.0.1:9999", caPath: "/x/ca.pem" });
  assert.equal(r.changed, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.env, { FOO: "1" });
});

test("removeProxyEnv leaves foreign proxy values alone", () => {
  const file = process.env.CLAUDE_SETTINGS_PATH!;
  fs.writeFileSync(file, JSON.stringify({ env: { HTTPS_PROXY: "http://corp:3128" } }));
  const r = removeProxyEnv({ proxyUrl: "http://127.0.0.1:8790", caPath: "/x/ca.pem" });
  assert.equal(r.changed, false);
  assert.equal(r.notes.length, 1);
});

// Claude Code decides these before a request exists, so the router cannot reach them by routing.
// `smallFast` is what a WebSearch side request runs on: until it moves, a routed session still
// searches on Claude quota.
test("model slots are written, changed and cleared, and uninstall always takes them back", () => {
  const file = process.env.CLAUDE_SETTINGS_PATH!;
  fs.writeFileSync(file, JSON.stringify({ env: { FOO: "1" } }));
  const proxy = { proxyUrl: "http://127.0.0.1:8790", caPath: "/x/ca.pem", force: false };

  applyProxyEnv({ ...proxy, models: { smallFast: "deepseek-flash", subagent: "gpt-5.6-terra" } });
  let env = JSON.parse(fs.readFileSync(file, "utf8")).env;
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "deepseek-flash");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "gpt-5.6-terra");
  assert.equal("ANTHROPIC_MODEL" in env, false, "an unset slot is not written");
  assert.equal(env.FOO, "1", "unrelated env is left alone");

  // Clearing a slot must remove it: leaving the old model behind would keep answering with nothing
  // in the config to explain why.
  const cleared = applyProxyEnv({ ...proxy, models: { smallFast: "deepseek-flash" } });
  assert.equal(cleared.changed, true);
  env = JSON.parse(fs.readFileSync(file, "utf8")).env;
  assert.equal("CLAUDE_CODE_SUBAGENT_MODEL" in env, false);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "deepseek-flash");

  // Passing no `models` at all is "do not manage these", not "clear them".
  applyProxyEnv({ ...proxy });
  env = JSON.parse(fs.readFileSync(file, "utf8")).env;
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "deepseek-flash");

  // Uninstalling hands the CLI back to Anthropic completely; a slot left pointing at a routed
  // model would send every search and subagent somewhere the router no longer serves.
  removeProxyEnv({ proxyUrl: "http://127.0.0.1:8790", caPath: "/x/ca.pem" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).env, { FOO: "1" });
});
