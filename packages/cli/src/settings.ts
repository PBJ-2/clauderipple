// Edit ~/.claude/settings.json: only the two env keys the CLI reads for the proxy.
// Always backs up first; never touches any other key; refuses to overwrite a foreign proxy unless forced.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SettingsEdit = { changed: boolean; backup: string | null; notes: string[] };

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

export function applyProxyEnv(opts: { proxyUrl: string; caPath: string; force: boolean; maxContextTokens?: number }): SettingsEdit {
  const file = settingsPath();
  const s = readSettings(file);
  const env = { ...((s.env as Record<string, string> | undefined) ?? {}) };
  const notes: string[] = [];
  const existing = env.HTTPS_PROXY;
  if (existing && existing !== opts.proxyUrl && !opts.force) {
    throw new Error(`settings.json env.HTTPS_PROXY is already "${existing}". Re-run with --force to replace it, or uninstall the other proxy first.`);
  }
  if (existing && existing !== opts.proxyUrl) notes.push(`replaced HTTPS_PROXY ${existing}`);
  const want: Record<string, string> = { HTTPS_PROXY: opts.proxyUrl, NODE_EXTRA_CA_CERTS: opts.caPath };
  if (opts.maxContextTokens) want.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(opts.maxContextTokens);
  let changed = false;
  for (const [k, v] of Object.entries(want)) {
    if (env[k] !== v) {
      env[k] = v;
      changed = true;
    }
  }
  if (!changed) return { changed: false, backup: null, notes };
  const b = backup(file);
  write(file, { ...s, env });
  return { changed: true, backup: b, notes };
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
  if (!changed) return { changed: false, backup: null, notes };
  const b = backup(file);
  const next = { ...s };
  if (Object.keys(env).length === 0) delete next.env;
  else next.env = env;
  write(file, next);
  return { changed: true, backup: b, notes };
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
  if (!changed) return { changed: false, backup: null, notes };
  const b = backup(file);
  hooks.PreToolUse = kept;
  s.hooks = hooks;
  write(file, s);
  return { changed: true, backup: b, notes };
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
