import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexOff, codexOn } from "../src/codex.ts";

test("codex on/off owns only marked provider and profile blocks", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-codex-"));
  const config = path.join(home, "config.toml");
  const profile = path.join(home, "clauderipple.config.toml");
  fs.writeFileSync(config, 'model = "gpt-6-astra"\n[plugins]\nenabled = true\n');
  fs.writeFileSync(profile, 'approval_policy = "never"\n');
  const on = codexOn(18793, home);
  assert.equal(on.changed, true);
  assert.ok(on.backup && fs.existsSync(on.backup));
  assert.match(fs.readFileSync(config, "utf8"), /\[model_providers\.clauderipple\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:18793\/v1"[\s\S]*wire_api = "responses"/);
  assert.match(fs.readFileSync(profile, "utf8"), /approval_policy = "never"[\s\S]*model_provider = "clauderipple"/);
  const off = codexOff(home);
  assert.equal(off.changed, true);
  assert.equal(fs.readFileSync(config, "utf8"), 'model = "gpt-6-astra"\n[plugins]\nenabled = true\n');
  assert.equal(fs.readFileSync(profile, "utf8"), 'approval_policy = "never"\n');
});
