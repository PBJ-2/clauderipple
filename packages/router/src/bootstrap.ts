// The CLI fetches /api/claude_cli/bootstrap once per session. Two fields matter to us:
//   additional_model_options  → the CLI's own /model list (NOT the app picker; docs/ARCHITECTURE.md §3)
//   auto_compact_windows      → per-model compaction thresholds; routed models are unknown to the CLI
//                               and would otherwise fall back to 200K.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";
import { agentAliases } from "./agents.ts";
import { isJudgeOnlyModel } from "./model-policy.ts";
import { chatPickerModels, pickerWindowOverride, providerModelWindow, resolvedModelWindow } from "./picker.ts";
import { chatgptModelWindow } from "./providers/chatgpt/windows.ts";

export const BOOTSTRAP_PATH = "/api/claude_cli/bootstrap";

/**
 * The largest per-model window Claude Code takes from `auto_compact_windows`. A value outside its
 * settings range (100K–1M in 2.1.308) is dropped whole and the model falls back to the session's
 * own setting, so Gemini's 1,048,576 never applied (read from the CLI, 2026-10-24). It is also the
 * cap `install` writes as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`: Claude Code compacts a model it does
 * not know at the smaller of that cap and the model's own window, and 272000 there cut 6.1 Sol's
 * 475000 and DeepSeek's million alike. With the cap at the ceiling, each model's window decides.
 */
export const CLI_WINDOW_MAX = 1_000_000;

/**
 * Model ids named in the user's agent definitions (~/.claude/agents/*.md frontmatter `model:`),
 * e.g. `gpt-5.6-terra@high`. The CLI only accepts ids it saw in its bootstrap list; an agent whose
 * model id is unknown silently runs on the parent session's Claude model (measured 2026-09-13 after
 * the picker ids lost their `@effort` suffix). Any such id whose base is routable is injected too.
 */
export function agentModelIds(dirs: string[] = [path.join(os.homedir(), ".claude", "agents")]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 8192);
        const m = /^model:\s*['"]?([A-Za-z0-9._\/:\-]+(?:@[a-z]+)?)/m.exec(head);
        if (m && !isJudgeOnlyModel(m[1]!)) out.add(m[1]!);
      } catch {
        /* unreadable: skip */
      }
    }
  }
  return [...out];
}

function routable(id: string, cfg: Config): boolean {
  const base = id.split("@")[0]!;
  if (cfg.cli.extraModels.some((m) => m.model === base)) return true;
  if (cfg.routes[base] || cfg.aliases[base]) return true;
  return cfg.direct.some((d) => base.startsWith(d.prefix));
}

export function bootstrapModels(cfg: Config, agentDirs?: string[]): ReturnType<typeof chatPickerModels> {
  const known = new Set(cfg.cli.extraModels.map((m) => m.model));
  // The agent files' derived aliases are the same set a marker resolves against, so an id an agent
  // file names (and its base) is routable here too — otherwise the CLI never lists it and the
  // subagent silently falls back to the parent session's Claude model.
  const aliasDir = agentDirs?.[0] ?? path.join(os.homedir(), ".claude", "agents");
  const aliases = { ...agentAliases(aliasDir), ...cfg.aliases };
  const fromAgents = agentModelIds(agentDirs)
    .filter((id) => !known.has(id) && routable(id, { ...cfg, aliases }))
    .map((id) => {
      const [base, effort] = id.split("@");
      const named = cfg.cli.extraModels.find((m) => m.model === base);
      // An "<model>@<effort>" entry is the same model with a different effort, so it has the same window.
      // A window the operator set on the picker entry wins; otherwise the live catalogue wins over
      // both the copied entry value and the provider's stored value (§4, 2026-10-30).
      const window = pickerWindowOverride({ ...cfg, aliases }, base ?? id) ?? chatgptModelWindow({ ...cfg, aliases }, base ?? id) ?? named?.contextWindow ?? providerModelWindow({ ...cfg, aliases }, base ?? id);
      return { model: id, name: `${named?.name ?? base}${effort ? ` · ${effort}` : ""}`, ...(window ? { contextWindow: window } : {}) };
    });
  return chatPickerModels({ ...cfg, aliases, cli: { ...cfg.cli, extraModels: [...cfg.cli.extraModels, ...fromAgents] } });
}

/** Raw capacities for exactly the keys bootstrap advertises, shared with settings reconciliation. */
export function bootstrapWindows(cfg: Config, extra = bootstrapModels(cfg)): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const m of extra) {
    const window = resolvedModelWindow(cfg, m.model).contextWindow ?? m.contextWindow ?? cfg.cli.autoCompactWindow;
    if (window) windows[m.model] = window;
  }
  for (const alias of Object.keys(cfg.routes)) {
    const window = resolvedModelWindow(cfg, alias).contextWindow ?? cfg.cli.autoCompactWindow;
    if (window) windows[alias] = window;
  }
  return windows;
}

export function injectBootstrap(body: Buffer, cfg: Config, agentDirs?: string[]): Buffer {
  const extra = bootstrapModels(cfg, agentDirs);
  const windows = bootstrapWindows(cfg, extra);
  const anyWindow = Object.keys(windows).length > 0;
  if (extra.length === 0 && !anyWindow) return body;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (extra.length > 0) {
    const existing = Array.isArray(j.additional_model_options) ? (j.additional_model_options as unknown[]) : [];
    // The CLI requires a description even when the config or an agent-derived entry omits it.
    j.additional_model_options = [...existing, ...extra.map((m) => ({ ...m, description: m.description ?? m.name ?? m.model }))];
  }
  if (anyWindow) {
    const acw = { ...((j.auto_compact_windows as Record<string, number> | undefined) ?? {}) };
    for (const [id, window] of Object.entries(windows)) acw[id] = Math.min(window, CLI_WINDOW_MAX);
    j.auto_compact_windows = acw;
  }
  return Buffer.from(JSON.stringify(j));
}
