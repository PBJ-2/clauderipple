// Claude Code's compaction point (`autoCompactWindow`) as the dashboard reads and writes it. It
// lives in settings.json, so these tests point CLAUDE_SETTINGS_PATH at a temp file — never the
// operator's own ~/.claude/settings.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  KEPT_WHEN_ABSENT,
  ModSettingsInputError,
  claudeSettingsPath,
  idleCompactionWanted,
  readAutoCompactWindow,
  readModSettings,
  reconcileIdleCompaction,
  writeAutoCompactWindow,
  writeIdleCompaction,
  writeModSettings,
} from "../src/mod-settings.ts";
import { MOD_SETTINGS_SCHEMA_VERSION, normalizeSettings } from "../../mod/hooks/settings.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ripple-compact-at-"));
}

function withSettingsFile(initial?: unknown): { dir: string; file: string; restore: () => void } {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2) + "\n");
  const previous = process.env.CLAUDE_SETTINGS_PATH;
  process.env.CLAUDE_SETTINGS_PATH = file;
  return {
    dir,
    file,
    restore: () => {
      if (previous === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
      else process.env.CLAUDE_SETTINGS_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("compactAt reads Claude Code's autoCompactWindow and is null without one", () => {
  const empty = withSettingsFile();
  try {
    assert.equal(claudeSettingsPath(), empty.file);
    assert.equal(readAutoCompactWindow(), null);
    assert.equal(readModSettings(empty.dir).compactAt, null);
  } finally { empty.restore(); }

  const set = withSettingsFile({ autoCompactWindow: 400000, model: "opus" });
  try {
    assert.equal(readAutoCompactWindow(), 400000);
    // The mod snapshot reports it beside the mod's own settings (normalized defaults here).
    const snapshot = readModSettings(set.dir);
    assert.equal(snapshot.compactAt, 400000);
    assert.equal(snapshot.stored, false);
  } finally { set.restore(); }
});

test("writing compactAt keeps every other settings.json key, backs up, and removal restores the default", () => {
  const t = withSettingsFile({ env: { HTTPS_PROXY: "http://127.0.0.1:8791" }, model: "sonnet", permissions: { allow: ["Read"] } });
  try {
    writeAutoCompactWindow(400000);
    const written = JSON.parse(fs.readFileSync(t.file, "utf8"));
    assert.equal(written.autoCompactWindow, 400000);
    assert.deepEqual(written.env, { HTTPS_PROXY: "http://127.0.0.1:8791" });
    assert.equal(written.model, "sonnet");
    assert.deepEqual(written.permissions, { allow: ["Read"] });
    // The previous bytes were kept.
    const backups = fs.readdirSync(t.dir).filter((name) => name.startsWith("settings.json.bak-clauderipple-"));
    assert.equal(backups.length, 1);
    assert.equal(readModSettings(t.dir).compactAt, 400000);

    // A second save replaces the value rather than adding a key beside it.
    writeAutoCompactWindow(600000);
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).autoCompactWindow, 600000);

    // "Model default" removes the override; the other keys stay.
    writeAutoCompactWindow(null);
    const removed = JSON.parse(fs.readFileSync(t.file, "utf8"));
    assert.equal(Object.hasOwn(removed, "autoCompactWindow"), false);
    assert.equal(removed.model, "sonnet");
    assert.deepEqual(removed.permissions, { allow: ["Read"] });
    assert.equal(readAutoCompactWindow(), null);
  } finally { t.restore(); }
});

test("a settings file that does not exist yet is created with just the compaction point", () => {
  const t = withSettingsFile();
  try {
    writeAutoCompactWindow(500000);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), { autoCompactWindow: 500000 });
  } finally { t.restore(); }
});

test("compactAt outside 100k..1M is refused and leaves the file untouched", () => {
  const t = withSettingsFile({ autoCompactWindow: 400000 });
  try {
    for (const value of [COMPACT_AT_MIN - 1, COMPACT_AT_MAX + 1, 1.5, Number.NaN]) {
      assert.throws(() => writeAutoCompactWindow(value), ModSettingsInputError, String(value));
    }
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).autoCompactWindow, 400000);
  } finally { t.restore(); }
});

test("a corrupt settings.json is never overwritten", () => {
  const t = withSettingsFile("{ not json");
  try {
    assert.throws(() => writeAutoCompactWindow(400000), ModSettingsInputError);
    assert.equal(fs.readFileSync(t.file, "utf8"), "{ not json");
    // Reading stays quiet: Claude Code owns the file, and this endpoint keeps answering.
    assert.equal(readAutoCompactWindow(), null);
  } finally { t.restore(); }
});

test("a per-model value /autocompact saved is read and preserved by a global dashboard save", () => {
  const t = withSettingsFile({ modelSettings: { "claude-opus-5": {}, "claude-opus-5-5": { autoCompactWindow: 400000, effort: "high" } } });
  try {
    assert.equal(readAutoCompactWindow(), 400000);
    writeAutoCompactWindow(500000);
    const written = JSON.parse(fs.readFileSync(t.file, "utf8"));
    assert.equal(written.autoCompactWindow, 500000);
    // User-specific model preferences still outrank the newly saved global default.
    assert.deepEqual(written.modelSettings, { "claude-opus-5": {}, "claude-opus-5-5": { autoCompactWindow: 400000, effort: "high" } });
    assert.equal(readAutoCompactWindow(), 500000);
  } finally { t.restore(); }

  const split = withSettingsFile({ modelSettings: { a: { autoCompactWindow: 400000 }, b: { autoCompactWindow: 600000 } } });
  try {
    // Models that disagree have no one value to show.
    assert.equal(readAutoCompactWindow(), null);
  } finally { split.restore(); }
});

// Claude Code's `idleCompaction` is derived from the toggle alone; keep-warm is decided per chat inside the mod.
test("idleCompact normalizes to true and only a boolean overrides it", () => {
  assert.equal(normalizeSettings(null).idleCompact, true);
  assert.equal(normalizeSettings({ idleCompact: "no" }).idleCompact, true);
  assert.equal(normalizeSettings({ idleCompact: false }).idleCompact, false);
  assert.equal(normalizeSettings({ idleCompact: true }).idleCompact, true);
});

test("idleCompaction is wanted exactly when the toggle is on, whatever keep-warm says", () => {
  for (const [idleCompact, keepWarm, wanted] of [[true, false, true], [true, true, true], [false, false, false], [false, true, false]] as const) {
    const stored = { idleCompact, keepWarm }; // the whole stored shape, as the router passes it
    assert.equal(idleCompactionWanted(stored), wanted, `toggle ${idleCompact}, keep-warm ${keepWarm}`);
  }
});

test("writeIdleCompaction writes false, deletes the key for true, keeps every other key, and skips no-ops", () => {
  const t = withSettingsFile({ model: "opus", autoCompactWindow: 400000, env: { A: "1" } });
  try {
    assert.equal(writeIdleCompaction(true), false, "already the default: nothing to write");
    assert.deepEqual(fs.readdirSync(t.dir), ["settings.json"], "no backup for a no-op");
    assert.equal(writeIdleCompaction(false), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), { model: "opus", autoCompactWindow: 400000, env: { A: "1" }, idleCompaction: false });
    assert.ok(fs.readdirSync(t.dir).some(name => name.startsWith("settings.json.bak-clauderipple-")), "previous bytes backed up");
    const before = fs.readFileSync(t.file, "utf8");
    assert.equal(writeIdleCompaction(false), false, "already false: unchanged");
    assert.equal(fs.readFileSync(t.file, "utf8"), before);
    assert.equal(writeIdleCompaction(true), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), { model: "opus", autoCompactWindow: 400000, env: { A: "1" } });
  } finally { t.restore(); }

  const missing = withSettingsFile();
  try {
    assert.equal(writeIdleCompaction(true), false);
    assert.equal(fs.existsSync(missing.file), false, "a missing file stays missing when the default is wanted");
    assert.equal(writeIdleCompaction(false), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(missing.file, "utf8")), { idleCompaction: false });
  } finally { missing.restore(); }
});

test("writeIdleCompaction refuses a settings.json that is not a JSON object", () => {
  for (const bad of ["{ not json", "[1,2]", "42"]) {
    const t = withSettingsFile(bad);
    try {
      assert.throws(() => writeIdleCompaction(false), (error: unknown) => error instanceof ModSettingsInputError && error.status === 409);
      assert.equal(fs.readFileSync(t.file, "utf8"), bad);
    } finally { t.restore(); }
  }
});

test("reconcileIdleCompaction derives the key from the stored mod settings (startup path)", () => {
  const t = withSettingsFile({ model: "opus" });
  try {
    // No store yet: the default toggle is on, so the key stays absent.
    assert.equal(reconcileIdleCompaction(t.dir), false);
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).idleCompaction, undefined);
    writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: { keepWarm: true } }, t.dir);
    assert.equal(reconcileIdleCompaction(t.dir), false, "keep-warm alone no longer turns it off");
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).idleCompaction, undefined);
    writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: { keepWarm: true, idleCompact: false } }, t.dir);
    assert.equal(reconcileIdleCompaction(t.dir), true, "toggle off writes false, keep-warm on or not");
    assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).idleCompaction, false);
    writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: { keepWarm: false, idleCompact: false } }, t.dir);
    assert.equal(reconcileIdleCompaction(t.dir), false, "toggle off keeps it false");
    writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: { keepWarm: true, idleCompact: true } }, t.dir);
    assert.equal(reconcileIdleCompaction(t.dir), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), { model: "opus" });
    // A false the earlier keep-warm rule wrote is removed once the toggle is on.
    fs.writeFileSync(t.file, JSON.stringify({ model: "opus", idleCompaction: false }));
    writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: { keepWarm: true, idleCompact: true } }, t.dir);
    assert.equal(reconcileIdleCompaction(t.dir), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), { model: "opus" });
  } finally { t.restore(); }
});

test("a save without idleCompact (a mod from before it existed) keeps the stored value; one that names it overrides", () => {
  const t = withSettingsFile({ model: "opus" });
  try {
    const save = (settings: Record<string, unknown>) => writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings }, t.dir).current.settings.idleCompact;
    assert.equal(save({ idleCompact: false }), false);
    assert.equal(save({ keepWarm: false }), false, "absent key: stored false survives");
    assert.equal(save({ idleCompact: true }), true, "explicit key still wins");
    assert.equal(save({ keepWarm: true }), true, "absent key: stored true survives");
    assert.equal(save({ idleCompact: "no" }), true, "a present but invalid value still normalizes to the default");
  } finally { t.restore(); }
});

test("a save without bandLimits (a mod from before it existed) keeps the stored choice; one that names it, [] included, replaces it", () => {
  const t = withSettingsFile({ model: "opus" });
  try {
    assert.deepEqual(KEPT_WHEN_ABSENT, ["idleCompact", "bandLimits"]);
    const chosen = [{ provider: "chatgpt", show: "accounts", accounts: ["fa928bf4"] }, { provider: "opencode-go", show: "off" }];
    const save = (settings: Record<string, unknown>) => writeModSettings({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings }, t.dir).current.settings;
    assert.deepEqual(save({ bandLimits: chosen, idleCompact: false }).bandLimits, chosen);
    const older = save({ keepWarm: true });
    assert.deepEqual(older.bandLimits, chosen, "absent key: the stored choice survives");
    assert.equal(older.idleCompact, false, "idleCompact is still kept beside it");
    assert.deepEqual(readModSettings(t.dir).settings.bandLimits, chosen, "and it is what the store holds");
    assert.deepEqual(save({ bandLimits: [{ provider: "chatgpt", show: "all" }] }).bandLimits, [{ provider: "chatgpt", show: "all" }], "a present key replaces");
    assert.deepEqual(save({ bandLimits: [] }).bandLimits, [], "a present [] clears");
    assert.deepEqual(save({ keepWarm: false }).bandLimits, [], "and a cleared choice stays cleared");
  } finally { t.restore(); }
});
