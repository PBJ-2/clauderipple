// The CLI fetches /api/claude_cli/bootstrap once per session. Two fields matter to us:
//   additional_model_options  → the CLI's own /model list (NOT the app picker; docs/ARCHITECTURE.md §3)
//   auto_compact_windows      → per-model compaction thresholds; routed models are unknown to the CLI
//                               and would otherwise fall back to 200K.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";

export const BOOTSTRAP_PATH = "/api/claude_cli/bootstrap";

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
        if (m) out.add(m[1]!);
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

export function injectBootstrap(body: Buffer, cfg: Config, agentDirs?: string[]): Buffer {
  const known = new Set(cfg.cli.extraModels.map((m) => m.model));
  const fromAgents = agentModelIds(agentDirs)
    .filter((id) => !known.has(id) && routable(id, cfg))
    .map((id) => {
      const [base, effort] = id.split("@");
      const named = cfg.cli.extraModels.find((m) => m.model === base);
      // An "<model>@<effort>" entry is the same model with a different effort, so it has the same window.
      return { model: id, name: `${named?.name ?? base}${effort ? ` · ${effort}` : ""}`, ...(named?.contextWindow ? { contextWindow: named.contextWindow } : {}) };
    });
  const extra = [...cfg.cli.extraModels, ...fromAgents];
  const win = cfg.cli.autoCompactWindow;
  // Routed models do not share a context window; the global value is only the fallback for entries
  // that do not name their own, so a per-entry window alone is reason enough to write the map.
  const anyWindow = win !== undefined || extra.some((m) => m.contextWindow) || Object.values(cfg.routes).some((r) => r.contextWindow);
  if (extra.length === 0 && !anyWindow) return body;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (extra.length > 0) {
    const existing = Array.isArray(j.additional_model_options) ? (j.additional_model_options as unknown[]) : [];
    j.additional_model_options = [...existing, ...extra];
  }
  if (anyWindow) {
    const acw = { ...((j.auto_compact_windows as Record<string, number> | undefined) ?? {}) };
    for (const m of extra) {
      const w = m.contextWindow ?? win;
      if (w) acw[m.model] = w;
    }
    for (const [alias, route] of Object.entries(cfg.routes)) {
      const w = route.contextWindow ?? win;
      if (w) acw[alias] = w;
    }
    j.auto_compact_windows = acw;
  }
  return Buffer.from(JSON.stringify(j));
}
