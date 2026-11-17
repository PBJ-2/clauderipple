// Edit ~/.claude/settings.json: only the two env keys the CLI reads for the proxy.
// Always backs up first; never touches any other key; refuses to overwrite a foreign proxy unless forced.
//
// This file is shared by every installation on the account, so what each one wrote is recorded
// beside it (owners.ts) and removed only by the home that recorded it (B02, 2026-10-25).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../../router/src/config.ts";
import { withFileLock, writeJsonAtomic } from "../../router/src/locked-file.ts";
import { type HomeClaims, type OwnerStore, type SlotClaims, claimedElsewhere, claimsOf, ownersPath, readOwners, setClaims } from "./owners.ts";
import { legacyIntegrationPath, sameHome } from "./ownership.ts";
import { reconcileCompactWindows } from "./compact-windows.ts";

/** Slots whose env value this call actually wrote or removed. Empty when the file already agreed. */
export type SlotName = "main" | "smallFast" | "subagent";

/**
 * How an ownership-gated removal ended. `preserved-other` (another installation's recorded claim)
 * is a success: the entry is not this home's to take. `preserved-unknown` and `failed` mean the
 * shared file may still name this installation, so a caller that must leave nothing behind stops.
 */
export type RemovalOutcome = "removed" | "absent" | "preserved-other" | "preserved-unknown" | "failed";

export type SettingsEdit = { changed: boolean; backup: string | null; notes: string[]; wroteSlots: SlotName[]; outcome?: RemovalOutcome };

export function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? path.join(os.homedir(), ".claude", "settings.json");
}

function readSettings(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  // A settings.json that is not a JSON object is not ours to repair by overwriting: every caller
  // would otherwise spread an array or a scalar into a new object and drop what was there.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; left untouched`);
  return parsed as Record<string, unknown>;
}

function backup(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const b = `${file}.bak-clauderipple-${ts}`;
  fs.copyFileSync(file, b);
  return b;
}

function write(file: string, obj: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Replace by rename: a reader (Claude Code, another installation) sees the old file or the new
  // one, never a half-written settings.json. The file's own permissions are kept.
  let mode: number | null = null;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* a new file: writeJsonAtomic's 0600 applies */
  }
  writeJsonAtomic(file, obj);
  if (mode !== null) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* a filesystem without POSIX modes (Windows) */
    }
  }
}

/**
 * One lock for the shared settings and the record of which installation wrote what.
 *
 * The lock is taken on settings.json itself — the same canonical file the router's
 * `writeAutoCompactWindow` (mod-settings.ts) locks — so the router and the CLI (and two CLI runs)
 * exclude each other. It is never taken on the ownership store alone: a writer that holds only
 * that would still race the settings. The whole read-modify-write happens inside it, so two
 * installations cannot lose each other's record, and a failed write leaves the values in place.
 *
 * Compatibility: versions from this change on take this lock; an older version takes none, so a
 * write from it can still interleave. That direction is safe — it records nothing, so it cannot
 * delete our claims; at worst our claim outlives a value it no longer describes, which a later
 * uninstall simply finds nothing to remove for.
 */
function withSettingsLock<T>(body: () => T): T {
  try {
    return withFileLock(settingsPath(), body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error(`another ClaudeRipple operation is changing Claude's settings; try again`);
    }
    throw error;
  }
}

/**
 * Claude Code's own model slots, as environment names. These are decided inside the CLI before a
 * request exists, so routing cannot reach them: `smallFast` in particular is what a `WebSearch`
 * side request runs on, which is why a routed session searches on Claude quota until it is set.
 */
export const MODEL_SLOT_ENV = {
  main: "ANTHROPIC_MODEL",
  smallFast: "ANTHROPIC_SMALL_FAST_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
} as const;

export type ModelSlots = Partial<Record<keyof typeof MODEL_SLOT_ENV, string>>;

/** Claude Code resolves its built-in aliases and optional context suffix before sending requests. */
export function isNativeClaudeModel(value: string): boolean {
  return /^(?:claude-[a-z0-9][a-z0-9._-]*|opus|sonnet|haiku)(?:\[1m\])?$/i.test(value);
}

/** Also applied to a remote host's settings.json (remote.ts): one rule for whose proxy wins. */
export function refuseForeignProxy(existing: string | undefined, proxyUrl: string, force: boolean): void {
  if (existing && existing !== proxyUrl && !force) {
    throw new Error(`settings.json env.HTTPS_PROXY is already "${existing}". Re-run with --force to replace it, or uninstall the other proxy first.`);
  }
}

/** The refusal `applyProxyEnv` would give, without writing: lets `install` fail before it registers anything. */
export function checkProxyEnv(opts: { proxyUrl: string; force: boolean }): void {
  refuseForeignProxy(currentProxyEnv().HTTPS_PROXY, opts.proxyUrl, opts.force);
}

function slotOwnershipPath(): string {
  // Tie ownership to the settings file, including when a caller uses an isolated settings path.
  return `${settingsPath()}.clauderipple-model-slots.json`;
}

/** The legacy record an older version wrote next to settings.json: read for a note, never trusted. */
function legacySlotClaims(): ModelSlots | null {
  const file = `${settingsPath()}.clauderipple-model-slots.json`;
  try {
    const claims = JSON.parse(fs.readFileSync(file, "utf8")) as ModelSlots;
    return claims && typeof claims === "object" && Object.keys(claims).length ? claims : null;
  } catch {
    return null;
  }
}

type Owners = { store: OwnerStore; mine: HomeClaims; error: string | null };

function owners(home: string): Owners {
  const { store, error } = readOwners(settingsPath());
  return { store, mine: claimsOf(store, home), error };
}

/** Saves the store; an empty store is removed rather than left as a file with no owner in it. */
function saveOwners(store: OwnerStore): string | null {
  try {
    if (Object.keys(store.homes).length === 0) fs.rmSync(ownersPath(settingsPath()), { force: true });
    else writeJsonAtomic(ownersPath(settingsPath()), store);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function applyProxyEnv(opts: { proxyUrl: string; caPath: string; maxContextTokens?: number; force: boolean; models?: ModelSlots; preserveUnnamedSlots?: boolean; respectDirect?: boolean; home?: string }): SettingsEdit {
  return withSettingsLock(() => applyProxyEnvLocked(opts));
}

function applyProxyEnvLocked(opts: { proxyUrl: string; caPath: string; force: boolean; maxContextTokens?: number; models?: ModelSlots; preserveUnnamedSlots?: boolean; respectDirect?: boolean; home?: string }): SettingsEdit {
  const home = opts.home ?? homeDir();
  if (opts.respectDirect && fs.existsSync(path.join(path.dirname(opts.caPath), "direct.json"))) {
    return { changed: false, backup: null, notes: ["left as it was: Claude is on its default connection (direct on)"], wroteSlots: [] };
  }
  const file = settingsPath();
  const s = readSettings(file);
  const env = { ...((s.env as Record<string, string> | undefined) ?? {}) };
  const notes: string[] = [];
  const existing = env.HTTPS_PROXY;
  refuseForeignProxy(existing, opts.proxyUrl, opts.force);
  if (existing && existing !== opts.proxyUrl) notes.push(`replaced HTTPS_PROXY ${existing}`);
  const want: Record<string, string> = { HTTPS_PROXY: opts.proxyUrl, NODE_EXTRA_CA_CERTS: opts.caPath };
  if (opts.maxContextTokens) want.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(opts.maxContextTokens);
  for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
    const model = opts.models?.[slot as keyof ModelSlots];
    if (model) want[name] = model;
  }
  const record = owners(home);
  if (record.error) {
    notes.push(`could not read ClaudeRipple's ownership record (${record.error}); settings.json was left as it was`);
    return { changed: false, backup: null, notes, wroteSlots: [] };
  }
  const wroteSlots: SlotName[] = [];
  const capBefore = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  let changed = false;
  for (const [k, v] of Object.entries(want)) {
    if (env[k] !== v) {
      env[k] = v;
      changed = true;
      const slot = (Object.keys(MODEL_SLOT_ENV) as SlotName[]).find((name) => MODEL_SLOT_ENV[name] === k);
      if (slot) wroteSlots.push(slot);
    }
  }
  const capAfter = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  const wroteCap = capAfter !== capBefore && capAfter !== undefined;
  // A slot that was set and is now cleared must go, or the old model keeps answering with nothing
  // in the config to explain why — but only where there is evidence it is this installation's.
  //
  // Which slots count as "now cleared" depends on the caller. `install` manages all three, so a
  // slot it was not given is cleared if this home recorded it, or if the caller named that slot
  // explicitly (the GUI's empty string). The GUI names only the slots it shows a choice for and
  // must leave the rest as they are — including a value someone put there by hand — so it passes
  // `preserveUnnamedSlots`. A value another installation records is never deleted (D3/D4).
  if (opts.models !== undefined) {
    const named = new Set(Object.keys(opts.models));
    for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
      if (opts.preserveUnnamedSlots && !named.has(slot)) continue;
      if (opts.models[slot as keyof ModelSlots]) continue;
      const current = env[name];
      if (current === undefined) continue;
      const theirs = claimedElsewhere(record.store, home, (c) => c.slots?.[slot], current);
      const recorded = record.mine.slots?.[slot] === current;
      // With no readable store nothing can be verified, and an unverifiable value is not deleted.
      if (!record.error && !theirs && (recorded || named.has(slot))) {
        delete env[name];
        changed = true;
        wroteSlots.push(slot as SlotName);
        notes.push(`cleared ${name}`);
      } else if (theirs) notes.push(`left ${name}=${current} (another installation records it)`);
      else if (!record.error) notes.push(`left ${name}=${current} (no record that this installation wrote it)`);
    }
  }
  // Record first, then change settings: a crash between the two leaves a claim for a value that was
  // never written (harmless), never a written value with no record (which a later uninstall would
  // have to guess at). A store that cannot be written stops the change (fail closed).
  const slots: SlotClaims = { ...(record.mine.slots ?? {}) };
  for (const slot of Object.keys(MODEL_SLOT_ENV) as SlotName[]) {
    const wanted = opts.models?.[slot];
    const name = MODEL_SLOT_ENV[slot];
    if (wanted && env[name] === wanted) {
      // A value is ours only with evidence: this call wrote it (even when another installation had
      // it first), this home recorded it before, or a second installation selects the same value
      // and must claim it too. A hand-written value that happens to equal what was asked for is
      // not evidence, and a later uninstall must leave it alone (D3/D4).
      const wrote = wroteSlots.includes(slot);
      const recorded = record.mine.slots?.[slot] === wanted;
      const theirs = claimedElsewhere(record.store, home, (c) => c.slots?.[slot], wanted);
      if (wrote || recorded || theirs) slots[slot] = wanted;
    } else if (wroteSlots.includes(slot) && env[name] === undefined) {
      delete slots[slot];
    }
  }
  if (JSON.stringify(slots) !== JSON.stringify(record.mine.slots ?? {})) {
    setClaims(record.store, home, { ...record.mine, slots });
    const failure = saveOwners(record.store);
    if (failure) {
      notes.push(`could not save ClaudeRipple's ownership record (${failure}); settings.json was left as it was`);
      return { changed: false, backup: null, notes, wroteSlots: [] };
    }
  }
  // The context cap `install` writes is recorded the same way, so uninstall can take back exactly
  // its own value and leave a hand-set one alone (G-D16, 2026-10-25).
  let contextCap = record.mine.contextCap;
  if (opts.maxContextTokens !== undefined) {
    if (capAfter !== undefined && (wroteCap || record.mine.contextCap === capAfter || claimedElsewhere(record.store, home, (c) => c.contextCap, capAfter))) contextCap = capAfter;
  }
  if (contextCap !== record.mine.contextCap) {
    setClaims(record.store, home, { ...record.mine, slots, ...(contextCap ? { contextCap } : {}) });
    const failure = saveOwners(record.store);
    if (failure) {
      notes.push(`could not save ClaudeRipple's ownership record (${failure}); settings.json was left as it was`);
      return { changed: false, backup: null, notes, wroteSlots: [] };
    }
  }
  if (!changed) return { changed: false, backup: null, notes, wroteSlots: [] };
  const b = backup(file);
  write(file, { ...s, env });
  return { changed: true, backup: b, notes, wroteSlots };
}

/**
 * Bring `~/.claude/settings.json` in line with `cli.models` after a GUI save.
 *
 * The GUI writes only config.json, and that is by design — the router hot-reloads it on mtime. But
 * these slots are read by Claude Code *before* a request exists, so they live in the env block and
 * nothing else writes them. Without this, choosing a slot on the Clients screen saved a value that
 * did nothing until the next `install`: the screen said DeepSeek while every search, title and
 * subagent went on running on Haiku (found this way, 2026-09-21).
 *
 * The GUI sends an empty string to mean "back to Claude" (`saveModelSlots` records every select,
 * so a slot set back to the default arrives as `""`). That is a key *present* with a falsy value,
 * which `applyProxyEnv` reads as "clear this one" and writes no env entry for — not the same thing
 * as `ANTHROPIC_MODEL: ""`, which would still be a key to Claude Code.
 *
 * A slot the GUI does not name at all is left alone, so a save here cannot undo a value someone
 * set by hand or through `install`.
 */
export function syncModelSlots(opts: { proxyUrl: string; caPath: string; force: boolean; models?: ModelSlots; home?: string }): SettingsEdit {
  return applyProxyEnv({ ...opts, preserveUnnamedSlots: true });
}

export function removeProxyEnv(opts: { proxyUrl: string; caPath: string; models?: ModelSlots; home?: string }): SettingsEdit {
  return withSettingsLock(() => removeProxyEnvLocked(opts));
}

function removeProxyEnvLocked(opts: { proxyUrl: string; caPath: string; models?: ModelSlots; home?: string }): SettingsEdit {
  const home = opts.home ?? homeDir();
  let record = owners(home);
  if (record.error) return { changed: false, backup: null, notes: [`could not read ClaudeRipple's ownership record (${record.error}); settings.json was left as it was`], wroteSlots: [] };
  const compactChanged = reconcileCompactWindows(settingsPath(), home, {});
  // Reconciliation released just the compact-window claims under this same settings lock.
  record = owners(home);
  const file = settingsPath();
  const s = readSettings(file);
  const env = { ...((s.env as Record<string, string> | undefined) ?? {}) };
  const notes: string[] = [];
  let changed = compactChanged;
  if (env.HTTPS_PROXY === opts.proxyUrl && env.NODE_EXTRA_CA_CERTS === opts.caPath) {
    delete env.HTTPS_PROXY;
    changed = true;
  } else if (env.HTTPS_PROXY) notes.push(`left HTTPS_PROXY=${env.HTTPS_PROXY} (not ours)`);
  if (env.NODE_EXTRA_CA_CERTS === opts.caPath) {
    delete env.NODE_EXTRA_CA_CERTS;
    changed = true;
  } else if (env.NODE_EXTRA_CA_CERTS) notes.push(`left NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS} (not ours)`);
  // A model slot goes only when this installation recorded writing that exact value and no other
  // installation records it too. A hand-written value, or one an older version recorded without
  // saying which installation wrote it, is left in place and named (D3/D4).
  for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
    const value = env[name];
    if (value === undefined) continue;
    const theirs = claimedElsewhere(record.store, home, (c) => c.slots?.[slot], value);
    // With no readable store nothing can be verified, and an unverifiable value is not deleted.
    if (!record.error && record.mine.slots?.[slot] === value && !theirs) {
      delete env[name];
      changed = true;
    } else if (theirs) notes.push(`left ${name}=${value} (another installation records it)`);
    else if (!record.error && opts.models?.[slot as keyof ModelSlots] === value) notes.push(`left ${name}=${value} (no record that this installation wrote it)`);
  }
  // The cap follows the same rule as a model slot: only the exact value this home recorded goes,
  // and a hand-set one is named and kept (G-D16).
  const cap = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (cap !== undefined) {
    const theirs = claimedElsewhere(record.store, home, (c) => c.contextCap, cap);
    if (!record.error && record.mine.contextCap === cap && !theirs) {
      delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      changed = true;
    } else if (theirs) notes.push(`kept CLAUDE_CODE_MAX_CONTEXT_TOKENS=${cap} (another installation records it)`);
    else if (!record.error && record.mine.contextCap !== cap) notes.push(`kept CLAUDE_CODE_MAX_CONTEXT_TOKENS=${cap} (no record that this installation wrote it)`);
  }
  if (!record.error) {
    const legacy = legacySlotClaims();
    if (legacy && Object.entries(MODEL_SLOT_ENV).some(([slot, name]) => typeof legacy[slot as keyof ModelSlots] === "string" && env[name] !== undefined)) {
      notes.push(`left model slots an older version recorded (${slotOwnershipPath()}); it does not say which installation wrote them`);
    }
    // Release this installation's claims before the values go: a crash leaves the value in place,
    // unrecorded, rather than leaving a record for a value somebody else may now hold.
    const next: HomeClaims = { ...record.mine };
    delete next.slots;
    delete next.contextCap;
    setClaims(record.store, home, next);
    const failure = saveOwners(record.store);
    if (failure) {
      notes.push(`could not save ClaudeRipple's ownership record (${failure}); settings.json was left as it was`);
      return { changed: false, backup: null, notes, wroteSlots: [] };
    }
  }
  // The router writes `idleCompaction: false` (never true) when it turns idle compaction off for
  // keep-warm or the user's toggle; with ClaudeRipple gone nothing would turn it back on. The key is
  // account-wide, so only the default home's uninstall removes it; another home's uninstall leaves it.
  const dropIdleCompaction = s.idleCompaction === false && sameHome(home, path.join(os.homedir(), ".clauderipple"));
  if (dropIdleCompaction) changed = true;
  if (!changed) return { changed: false, backup: null, notes, wroteSlots: [] };
  const b = backup(file);
  const next = { ...s };
  if (dropIdleCompaction) delete next.idleCompaction;
  if (Object.keys(env).length === 0) delete next.env;
  else next.env = env;
  write(file, next);
  return { changed: true, backup: b, notes, wroteSlots: [] };
}

/**
 * Applies `mutate` to a copy of settings.json's env block and writes it back (with a backup) only
 * when it reports a change. Every other key in the file is kept as it was; an emptied env block is
 * dropped. For callers that own a precise set of keys, such as `direct on|off`.
 */
export function editSettingsEnv(mutate: (env: Record<string, string>) => boolean, afterWrite?: () => void): SettingsEdit {
  return withSettingsLock(() => {
    const result = editSettingsEnvLocked(mutate);
    afterWrite?.();
    return result;
  });
}

function editSettingsEnvLocked(mutate: (env: Record<string, string>) => boolean): SettingsEdit {
  const file = settingsPath();
  const s = readSettings(file);
  const env = { ...((s.env as Record<string, string> | undefined) ?? {}) };
  if (!mutate(env)) return { changed: false, backup: null, notes: [], wroteSlots: [] };
  const b = backup(file);
  const next = { ...s };
  if (Object.keys(env).length === 0) delete next.env;
  else next.env = env;
  write(file, next);
  return { changed: true, backup: b, notes: [], wroteSlots: [] };
}

/** settings.json's whole env block (empty when the file or the block is missing). */
export function settingsEnv(): Record<string, string> {
  return { ...((readSettings(settingsPath()).env as Record<string, string> | undefined) ?? {}) };
}

export function currentProxyEnv(): { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string; CLAUDE_CODE_MAX_CONTEXT_TOKENS?: string } {
  const env = (readSettings(settingsPath()).env as Record<string, string> | undefined) ?? {};
  const out: { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string; CLAUDE_CODE_MAX_CONTEXT_TOKENS?: string } = {};
  if (env.HTTPS_PROXY) out.HTTPS_PROXY = env.HTTPS_PROXY;
  if (env.NODE_EXTRA_CA_CERTS) out.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) out.CLAUDE_CODE_MAX_CONTEXT_TOKENS = env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  return out;
}

// ---- Agent-title hook (PreToolUse Agent|Task) -------------------------------------------

const HOOK_MARK = "_clauderipple";
type HookEntry = { matcher?: string; hooks?: Record<string, unknown>[]; [k: string]: unknown };

/** One POSIX-quoted word for the hook command. */
function shellQuote(value: string): string {
  return '"' + value.replace(/(["\\$`])/g, "\\$1") + '"';
}

/** The command string an entry runs, or null when the entry is not in the shape we write. */
function hookCommand(entry: HookEntry): string | null {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const first = hooks[0] as { command?: unknown } | undefined;
  return typeof first?.command === "string" ? first.command : null;
}

/** The exact command ClaudeRipple writes for `cmd`. */
function buildHookCommand(cmd: { node: string; env?: Record<string, string>; script: string }): string {
  const prefix = Object.entries(cmd.env ?? {})
    .map(([key, value]) => (/^[A-Za-z0-9_./:-]+$/.test(value) ? `${key}=${value}` : `${key}=${shellQuote(value)}`))
    .join(" ");
  return [prefix, shellQuote(cmd.node), shellQuote(cmd.script)].filter(Boolean).join(" ");
}

/** The words of a command string, or null when its quoting is unbalanced. */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quoted) {
      if (ch === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) {
        current += command[i + 1];
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = "";
    } else current += ch;
  }
  if (quoted) return null;
  if (current) words.push(current);
  return words;
}

/** The script path a hook command runs: its last word, in the shape buildHookCommand writes. */
function hookScriptPath(command: string): string | null {
  const words = shellWords(command);
  const last = words?.[words.length - 1];
  if (!last) return null;
  return path.isAbsolute(last) || /^[A-Za-z]:[\\/]/.test(last) ? last : null;
}

/** Combines per-entry verdicts into the one outcome a caller acts on. */
function removalOutcome(opts: { failed: boolean; unknown: number; other: number; changed: boolean }): RemovalOutcome {
  if (opts.failed) return "failed";
  if (opts.unknown > 0) return "preserved-unknown";
  if (opts.other > 0) return "preserved-other";
  return opts.changed ? "removed" : "absent";
}

/** Adds or removes ClaudeRipple's PreToolUse hook. Only entries owned by this installation are touched. */
export function setAgentTitleHook(enabled: boolean, cmd: { node: string; env?: Record<string, string>; script: string }, opts: { home?: string } = {}): SettingsEdit {
  return withSettingsLock(() => setAgentTitleHookLocked(enabled, cmd, opts));
}

function setAgentTitleHookLocked(enabled: boolean, cmd: { node: string; env?: Record<string, string>; script: string }, opts: { home?: string }): SettingsEdit {
  const home = opts.home ?? homeDir();
  const file = settingsPath();
  const s = readSettings(file);
  const hooks = (typeof s.hooks === "object" && s.hooks ? (s.hooks as Record<string, unknown>) : {});
  const list = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  const record = owners(home);
  const notes: string[] = [];
  if (record.error) {
    notes.push(`could not read ClaudeRipple's ownership record (${record.error}); settings.json was left as it was`);
    return { changed: false, backup: null, notes, wroteSlots: [], outcome: "failed" };
  }
  const command = buildHookCommand(cmd);
  // An entry needs this home's exact command record or a known legacy generated script path
  // without a nested installation. Another installation's claim always preserves the entry.
  const recorded = new Set(record.mine.hooks ?? []);
  const kept: HookEntry[] = [];
  let removed = 0;
  let other = 0;
  let unknown = 0;
  const existing = list.find((entry) => entry[HOOK_MARK] === "agent-title" && hookCommand(entry) === command);
  for (const entry of list) {
    if (entry[HOOK_MARK] !== "agent-title") {
      kept.push(entry);
      continue;
    }
    const runs = hookCommand(entry);
    const elsewhere = runs !== null && claimedElsewhere(record.store, home, (c) => c.hooks, runs);
    const script = runs === null ? null : hookScriptPath(runs);
    const legacy = runs !== null && !recorded.has(runs) && !elsewhere && script !== null && legacyIntegrationPath(script, home, ["lib/node_modules/clauderipple/dist/cli/src/hooks/agent-title.js"]);
    const isOurs = runs !== null && recorded.has(runs) && !elsewhere;
    if (elsewhere) {
      kept.push(entry);
      other++;
    } else if (isOurs || legacy) {
      // `on` keeps the exact entry it would write and replaces its own stale ones; `off` takes all.
      if (enabled && entry === existing) kept.push(entry);
      else removed++;
    } else {
      kept.push(entry);
      unknown++;
    }
  }
  if (enabled) {
    if (!existing) {
      kept.push({
        matcher: "Agent|Task",
        hooks: [{ type: "command", command, timeout: 10 }],
        [HOOK_MARK]: "agent-title",
      });
    }
    notes.push("hooks.PreToolUse: ClaudeRipple agent-title hook added");
  } else if (removed > 0) {
    notes.push("hooks.PreToolUse: ClaudeRipple agent-title hook removed");
  }
  if (other > 0) notes.push("hooks.PreToolUse: left an agent-title hook another installation records");
  if (unknown > 0) notes.push("hooks.PreToolUse: left an agent-title hook this installation did not record and that does not run from its home");
  const changed = JSON.stringify(kept) !== JSON.stringify(list);
  // An explicit `on` records the command even when the entry was already there, so a later `off`
  // or uninstall has home-specific evidence with which to remove it.
  let failed = false;
  {
    const next: HomeClaims = { ...record.mine };
    if (enabled) next.hooks = [command];
    else delete next.hooks;
    setClaims(record.store, home, next);
    const failure = saveOwners(record.store);
    if (failure) {
      failed = true;
      notes.push(`could not save ClaudeRipple's ownership record (${failure}); settings.json was left as it was`);
    }
  }
  if (failed) return { changed: false, backup: null, notes, wroteSlots: [], outcome: "failed" };
  const outcome = removalOutcome({ failed, unknown, other, changed });
  if (!changed) return { changed: false, backup: null, notes, wroteSlots: [], ...(enabled ? {} : { outcome }) };
  const b = backup(file);
  hooks.PreToolUse = kept;
  s.hooks = hooks;
  write(file, s);
  return { changed: true, backup: b, notes, wroteSlots: [], ...(enabled ? {} : { outcome }) };
}

export function agentTitleHookEnabled(): boolean {
  try {
    const s = readSettings(settingsPath());
    const list = (s.hooks as Record<string, unknown> | undefined)?.PreToolUse;
    return Array.isArray(list) && list.some((e) => (e as HookEntry)[HOOK_MARK] === "agent-title");
  } catch {
    return false;
  }
}

// ---- Status mod (packages/mod) ------------------------------------------------------------

/** The `name` in packages/mod/.claude-plugin/plugin.json: how our entry is told from anyone else's. */
export const STATUS_MOD_NAME = "ripple";
/** Its name until 0.8.10: an entry an older install added is still ours to replace or remove. */
const OLD_STATUS_MOD_NAMES = ["clauderipple-status"];
const PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS";

function isStatusMod(dir: string): boolean {
  try {
    const name = (JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown }).name;
    return name === STATUS_MOD_NAME || OLD_STATUS_MOD_NAMES.includes(name as string);
  } catch {
    return false;
  }
}

function pluginDirs(env: Record<string, string>): string[] {
  return (env[PLUGIN_DIRS] ?? "").split(path.delimiter).filter(Boolean);
}

/**
 * Registers or removes the status mod in settings.json's `env.CLAUDE_CODE_PLUGIN_DIRS`, the one
 * place a session the desktop app starts reads plugin folders from (Claude Code docs, plugin
 * authoring reference, CLI 2.1.286). The variable is a path list other plugins may share: only a
 * folder this installation recorded is removed, and another installation's claim keeps it. A
 * folder an older version left with no record needs an exact known generated path with no nested
 * installation and no other installation's claim; arbitrary descendants and source checkouts are
 * unknown and preserved. The variable goes only when it is left empty
 * (D3, 2026-10-25).
 */
export function setStatusMod(enabled: boolean, dir: string, opts: { home?: string } = {}): SettingsEdit {
  return withSettingsLock(() => setStatusModLocked(enabled, dir, opts));
}

function setStatusModLocked(enabled: boolean, dir: string, opts: { home?: string }): SettingsEdit {
  const home = opts.home ?? homeDir();
  const file = settingsPath();
  const s = readSettings(file);
  const env = { ...((s.env as Record<string, string> | undefined) ?? {}) };
  const before = pluginDirs(env);
  const record = owners(home);
  const notes: string[] = [];
  if (record.error) {
    notes.push(`could not read ClaudeRipple's ownership record (${record.error}); settings.json was left as it was`);
    return { changed: false, backup: null, notes, wroteSlots: [], outcome: "failed" };
  }
  const recorded = new Set((record.mine.mods ?? []).map((entry) => path.resolve(entry)));
  const kept: string[] = [];
  let other = 0;
  let unknown = 0;
  for (const entry of before) {
    const mine = recorded.has(path.resolve(entry));
    const elsewhere = claimedElsewhere(record.store, home, (c) => c.mods, entry);
    // A folder with no record is ours only when it is inside this installation's home and is (or
    // was) the status mod; anything else says nothing about who registered it.
    const legacy = !mine && !elsewhere && legacyIntegrationPath(entry, home, ["mod", "lib/node_modules/clauderipple/dist/mod"]) && (!fs.existsSync(entry) || isStatusMod(entry));
    if (elsewhere) {
      kept.push(entry);
      other++;
    } else if (mine || legacy) {
      // Ours: `off` takes it, `on` replaces the list with the current folder below.
      continue;
    } else {
      if (isStatusMod(entry)) unknown++;
      kept.push(entry);
    }
  }
  const after = enabled ? [...kept.filter((entry) => path.resolve(entry) !== path.resolve(dir)), dir] : kept;
  const changed = after.join(path.delimiter) !== before.join(path.delimiter);
  // An explicit `on` records the folder even when the list already had it, so a later `off` or
  // uninstall has home-specific evidence with which to remove it. Recording happens first: a
  // crash between the two leaves a claim without its entry, never an entry with no record.
  let failed = false;
  {
    setClaims(record.store, home, { ...record.mine, mods: enabled ? [dir] : [] });
    const failure = saveOwners(record.store);
    if (failure) {
      failed = true;
      notes.push(`could not save ClaudeRipple's ownership record (${failure}); settings.json was left as it was`);
    }
  }
  if (failed) return { changed: false, backup: null, notes, wroteSlots: [], outcome: "failed" };
  if (other > 0) notes.push(`env.${PLUGIN_DIRS}: left a status mod another installation registered`);
  if (unknown > 0) notes.push(`env.${PLUGIN_DIRS}: left a status mod entry this installation did not record and that is not inside its home`);
  const outcome = removalOutcome({ failed, unknown, other, changed });
  if (!changed) return { changed: false, backup: null, notes, wroteSlots: [], ...(enabled ? {} : { outcome }) };
  if (after.length > 0) env[PLUGIN_DIRS] = after.join(path.delimiter);
  else delete env[PLUGIN_DIRS];
  const b = backup(file);
  s.env = env;
  write(file, s);
  notes.push(`env.${PLUGIN_DIRS}: ClaudeRipple status mod ${enabled ? "added" : "removed"}`);
  return { changed: true, backup: b, notes, wroteSlots: [], ...(enabled ? {} : { outcome }) };
}

export function statusModEnabled(): boolean {
  try {
    return pluginDirs((readSettings(settingsPath()).env as Record<string, string> | undefined) ?? {}).some(isStatusMod);
  } catch {
    return false;
  }
}
