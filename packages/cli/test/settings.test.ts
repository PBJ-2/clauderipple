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
