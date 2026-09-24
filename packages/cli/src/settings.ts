// Edit ~/.claude/settings.json: only the two env keys the CLI reads for the proxy.
// Always backs up first; never touches any other key; refuses to overwrite a foreign proxy unless forced.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Slots whose env value this call actually wrote or removed. Empty when the file already agreed. */
export type SlotName = "main" | "smallFast" | "subagent";

export type SettingsEdit = { changed: boolean; backup: string | null; notes: string[]; wroteSlots: SlotName[] };

export function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? path.join(os.homedir(), ".claude", "settings.json");
}

function readSettings(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as Record<string, unknown>;
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
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
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

function refuseForeignProxy(existing: string | undefined, proxyUrl: string, force: boolean): void {
  if (existing && existing !== proxyUrl && !force) {
    throw new Error(`settings.json env.HTTPS_PROXY is already "${existing}". Re-run with --force to replace it, or uninstall the other proxy first.`);
  }
}

/** The refusal `applyProxyEnv` would give, without writing: lets `install` fail before it registers anything. */
export function checkProxyEnv(opts: { proxyUrl: string; force: boolean }): void {
  refuseForeignProxy(currentProxyEnv().HTTPS_PROXY, opts.proxyUrl, opts.force);
}

export function applyProxyEnv(opts: { proxyUrl: string; caPath: string; force: boolean; maxContextTokens?: number; models?: ModelSlots; preserveUnnamedSlots?: boolean }): SettingsEdit {
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
  const wroteSlots: SlotName[] = [];
  let changed = false;
  for (const [k, v] of Object.entries(want)) {
    if (env[k] !== v) {
      env[k] = v;
      changed = true;
      const slot = (Object.keys(MODEL_SLOT_ENV) as SlotName[]).find((name) => MODEL_SLOT_ENV[name] === k);
      if (slot) wroteSlots.push(slot);
    }
  }
  // A slot that was set and is now cleared must go, or the old model keeps answering with nothing
  // in the config to explain why.
  //
  // Which slots count as "now cleared" depends on the caller. `install` owns all three, so anything
  // it was not given is cleared. The GUI names only the slots it shows a choice for and must leave
  // the rest as they are — including a value someone put there by hand — so it passes
  // `preserveUnnamedSlots` and a slot it never mentioned is simply not touched.
  if (opts.models !== undefined) {
    const named = new Set(Object.keys(opts.models));
    for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
      if (opts.preserveUnnamedSlots && !named.has(slot)) continue;
      if (!opts.models[slot as keyof ModelSlots] && env[name] !== undefined) {
        delete env[name];
        changed = true;
        wroteSlots.push(slot as SlotName);
        notes.push(`cleared ${name}`);
      }
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
export function syncModelSlots(opts: { proxyUrl: string; caPath: string; force: boolean; models?: ModelSlots }): SettingsEdit {
  return applyProxyEnv({ ...opts, preserveUnnamedSlots: true });
}

export function removeProxyEnv(opts: { proxyUrl: string; caPath: string }): SettingsEdit {
  const file = settingsPath();
  const s = readSettings(file);
  const env = { ...((s.env as Record<string, string> | undefined) ?? {}) };
  const notes: string[] = [];
  let changed = false;
  if (env.HTTPS_PROXY === opts.proxyUrl) {
    delete env.HTTPS_PROXY;
    changed = true;
  } else if (env.HTTPS_PROXY) notes.push(`left HTTPS_PROXY=${env.HTTPS_PROXY} (not ours)`);
  if (env.NODE_EXTRA_CA_CERTS === opts.caPath) {
    delete env.NODE_EXTRA_CA_CERTS;
    changed = true;
  } else if (env.NODE_EXTRA_CA_CERTS) notes.push(`left NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS} (not ours)`);
  // Uninstalling must hand the CLI back to Anthropic completely: a model slot still pointing at a
  // routed model would send every search and subagent somewhere the router no longer serves.
  for (const name of Object.values(MODEL_SLOT_ENV)) {
    if (env[name] !== undefined) {
      delete env[name];
      changed = true;
    }
  }
  if (!changed) return { changed: false, backup: null, notes, wroteSlots: [] };
  const b = backup(file);
  const next = { ...s };
  if (Object.keys(env).length === 0) delete next.env;
  else next.env = env;
  write(file, next);
  return { changed: true, backup: b, notes, wroteSlots: [] };
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

/** Adds or removes ClaudeRipple's PreToolUse hook. Only entries carrying our marker are ever touched. */
function shellQuote(value: string): string {
  return '"' + value.replace(/(["\\$`])/g, "\\$1") + '"';
}

export function setAgentTitleHook(enabled: boolean, cmd: { node: string; env?: Record<string, string>; script: string }): SettingsEdit {
  const file = settingsPath();
  const s = readSettings(file);
  const hooks = (typeof s.hooks === "object" && s.hooks ? (s.hooks as Record<string, unknown>) : {});
  const list = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  const kept = list.filter((e) => e[HOOK_MARK] !== "agent-title");
  const notes: string[] = [];
  if (enabled) {
    const prefix = Object.entries(cmd.env ?? {})
      .map(([key, value]) => /^[A-Za-z0-9_./:-]+$/.test(value) ? `${key}=${value}` : `${key}=${shellQuote(value)}`)
      .join(" ");
    const command = [prefix, shellQuote(cmd.node), shellQuote(cmd.script)].filter(Boolean).join(" ");
    kept.push({
      matcher: "Agent|Task",
      hooks: [{ type: "command", command, timeout: 10 }],
      [HOOK_MARK]: "agent-title",
    });
    notes.push("hooks.PreToolUse: ClaudeRipple agent-title hook added");
  } else if (kept.length !== list.length) {
    notes.push("hooks.PreToolUse: ClaudeRipple agent-title hook removed");
  }
  const changed = JSON.stringify(kept) !== JSON.stringify(list);
  if (!changed) return { changed: false, backup: null, notes, wroteSlots: [] };
  const b = backup(file);
  hooks.PreToolUse = kept;
  s.hooks = hooks;
  write(file, s);
  return { changed: true, backup: b, notes, wroteSlots: [] };
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
