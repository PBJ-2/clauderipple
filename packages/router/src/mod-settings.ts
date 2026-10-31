// Persistence and normalization have one source each: the router's locked store
// and the mod's pure schema (no claude-code runtime dependency).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "./config.ts";
import { withFileLock, writeJsonAtomic } from "./locked-file.ts";
import { readOwners } from "../../cli/src/owners.ts";
import { MOD_SETTINGS_SCHEMA_VERSION, hadRetiredRouting, normalizeSettings } from "../../mod/hooks/settings.ts";
import type { ModSettingsSnapshot } from "../../mod/types/index.d.ts";

export const MAX_MOD_SETTINGS_BYTES = 64 * 1024;

/** The range the dashboard accepts for Claude Code's own compaction point, in tokens. */
export const COMPACT_AT_MIN = 100_000;
export const COMPACT_AT_MAX = 1_000_000;
export type { ModSettingsSnapshot };

export class ModSettingsInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A field that holds a credential: its last word is key, token, secret, password or the like
 * (`apiKey`, `access_token`, `typesafeKey`). The last word decides, so a count such as
 * `keepWarmMinTokens` — a setting the mod has — is not mistaken for one.
 */
function isSecretName(key: string): boolean {
  const last = key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  return ["key", "apikey", "token", "secret", "password", "passwd", "authorization", "credential", "credentials", "bearer"].includes(last);
}

/** Iterative traversal also checks objects nested in arrays, without a recursion limit. */
function hasSecretKey(settings: Record<string, unknown>): boolean {
  const pending: unknown[] = [settings];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (isSecretName(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

export function validateSettings(settings: unknown): asserts settings is Record<string, unknown> {
  if (!object(settings)) throw new ModSettingsInputError("settings must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(settings), "utf8") > MAX_MOD_SETTINGS_BYTES) throw new ModSettingsInputError("settings exceeds 64 KiB", 413);
  if (hasSecretKey(settings)) throw new ModSettingsInputError("settings must not contain credential fields (key, token, secret, password)");
}

/** Claude Code's settings.json; CLAUDE_SETTINGS_PATH is the test/runtime override the cli uses too. */
export function claudeSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? path.join(os.homedir(), ".claude", "settings.json");
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Claude Code's own compaction window from settings.json: the top-level `autoCompactWindow`, else
 * the one value `/autocompact <n>` saved under `modelSettings.<model>` (it saves per model, and a
 * per-model value outranks the top-level one). Null when absent or when models disagree, so the
 * model's default stands.
 */
export function readAutoCompactWindow(): number | null {
  let text: string;
  try { text = fs.readFileSync(claudeSettingsPath(), "utf8"); }
  catch {
    // Missing or unreadable (an install that never wrote it): the model's default stands.
    return null;
  }
  if (!text.trim()) return null;
  try {
    const settings = JSON.parse(text) as Record<string, unknown>;
    const top = tokenCount(settings.autoCompactWindow);
    if (top !== null) return top;
    const models = object(settings.modelSettings) ? Object.entries(settings.modelSettings) : [];
    const { store } = readOwners(claudeSettingsPath());
    const values = new Set(models.map(([id, m]) => {
      if (!object(m) || Object.values(store.homes).some(c => c.compactWindows?.[id] === m.autoCompactWindow)) return null;
      return tokenCount(m.autoCompactWindow);
    }).filter(v => v !== null));
    return values.size === 1 ? [...values][0]! : null;
  } catch {
    // A corrupt file is Claude Code's own problem; keep this endpoint answering rather than fail it.
    return null;
  }
}

/**
 * Write or remove the global `autoCompactWindow`, preserving user per-model preferences.
 * Router-owned per-model values are reconciled separately under this same file lock; a dashboard
 * save must never erase a user's explicit model override (2026-10-28). Backs up the previous
 * bytes first and replaces the file atomically, as `cli/src/settings.ts` does for
 * the env block. `null` removes the override (the model's default).
 */
export function writeAutoCompactWindow(tokens: number | null): void {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < COMPACT_AT_MIN || tokens > COMPACT_AT_MAX)) {
    throw new ModSettingsInputError(`compactAt must be ${COMPACT_AT_MIN}..${COMPACT_AT_MAX} tokens or null`);
  }
  const file = claudeSettingsPath();
  withFileLock(file, () => {
    let previous: string | null = null;
    try { previous = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let current: Record<string, unknown> = {};
    if (previous !== null && previous.trim()) {
      try {
        const parsed: unknown = JSON.parse(previous);
        if (!object(parsed)) throw new Error("not an object");
        current = parsed;
      } catch {
        throw new ModSettingsInputError("settings.json is not a JSON object; compactAt was not written", 409);
      }
    }
    const next = { ...current };
    if (tokens === null) delete next.autoCompactWindow;
    else next.autoCompactWindow = tokens;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    if (previous !== null) {
      const backup = `${file}.bak-clauderipple-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
      fs.copyFileSync(file, backup);
      fs.chmodSync(backup, 0o600);
    }
    writeJsonAtomic(file, next);
  });
}

type StoredModSettings = Omit<ModSettingsSnapshot, "compactAt">;
const modSettingsCache = new Map<string, { version: string; snapshot: StoredModSettings; compactModel: string | undefined }>();

/** Absence is not the UI's normalized Haiku default: an unset compaction target changes nothing. */
export function readCompactModel(home = homeDir()): string | undefined {
  readModRoutingSettings(home);
  return modSettingsCache.get(path.join(home, "mod-settings.json"))?.compactModel;
}

/** Worker authorization needs only this store, never Claude Code's compaction/ownership files. */
export function readModRoutingSettings(home = homeDir()): StoredModSettings {
  const file = path.join(home, "mod-settings.json");
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch (error) {
    modSettingsCache.delete(file);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: normalizeSettings(null), revision: 0, stored: false };
    throw error;
  }
  // Atomic replacement and permission changes invalidate too, even if mtime is preserved.
  const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.size}:${stat.mode}`;
  const cached = modSettingsCache.get(file);
  if (cached?.version === version) return structuredClone(cached.snapshot);
  modSettingsCache.delete(file);
  // Corruption/unreadability is not an empty store, nor authority to reuse a previous good value.
  const stored: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!object(stored) || !revision(stored.revision) || stored.revision < 1) throw new Error("invalid mod settings store");
  validateSettings(stored.settings);
  const snapshot: StoredModSettings = {
    settings: normalizeSettings(stored.settings), revision: stored.revision, stored: true,
    ...(hadRetiredRouting(stored.settings) ? { legacy: true } : {}),
  };
  const compactModel = typeof stored.settings.compactModel === "string" && stored.settings.compactModel.trim() ? stored.settings.compactModel.trim() : undefined;
  modSettingsCache.set(file, { version, snapshot, compactModel });
  if (modSettingsCache.size > 32) modSettingsCache.delete(modSettingsCache.keys().next().value!);
  return structuredClone(snapshot);
}

export function readModSettings(home = homeDir()): ModSettingsSnapshot {
  return { ...readModRoutingSettings(home), compactAt: readAutoCompactWindow() };
}

/** Reject old writers before normalization/fill can erase evidence of their format. */
export function validateSettingsSchema(body: unknown): void {
  if (!object(body)) throw new ModSettingsInputError("body must be a JSON object");
  if (body.schemaVersion !== MOD_SETTINGS_SCHEMA_VERSION) throw new ModSettingsInputError("settings schema unsupported; reload ClaudeRipple before saving", 426);
}

/** Exact previous bytes, not the normalized read view; backup failure aborts the write. */
function backupModSettings(file: string, previousRevision: number): void {
  const backup = `${file}.bak-${previousRevision}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  // Windows refuses to flush a read-only handle (EPERM, #53), so the backup is opened for writing.
  const fd = fs.openSync(backup, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const backups = fs.readdirSync(path.dirname(file)).filter(name => /^mod-settings\.json\.bak-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
  for (const name of backups.slice(10)) fs.unlinkSync(path.join(path.dirname(file), name));
}

export type ModSettingsWrite = { stale: boolean; current: ModSettingsSnapshot };

/** Compare-and-swap and revision increment share the account stores' cross-process lock. */
export function writeModSettings(body: unknown, home = homeDir()): ModSettingsWrite {
  if (!object(body)) throw new ModSettingsInputError("body must be a JSON object");
  validateSettingsSchema(body);
  validateSettings(body.settings);
  if (body.revision !== undefined && !revision(body.revision)) throw new ModSettingsInputError("revision must be a non-negative safe integer");
  const settings = normalizeSettings(body.settings);
  validateSettings(settings);
  const expected = body.revision;
  const file = path.join(home, "mod-settings.json");
  return withFileLock(file, () => {
    const current = readModSettings(home);
    if (expected !== undefined && expected !== current.revision) return { stale: true, current };
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("mod settings revision exhausted");
    // `compactAt` is reported in the answer but never stored here: settings.json is its one home.
    const next: ModSettingsSnapshot = { settings, revision: current.revision + 1, stored: true, compactAt: readAutoCompactWindow() };
    if (current.stored) backupModSettings(file, current.revision);
    writeJsonAtomic(file, { settings: next.settings, revision: next.revision, stored: next.stored });
    return { stale: false, current: next };
  });
}
