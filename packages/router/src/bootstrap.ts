// The CLI fetches /api/claude_cli/bootstrap once per session. Two fields matter to us:
//   additional_model_options  → the CLI's own /model list (NOT the app picker; docs/ARCHITECTURE.md §3)
//   auto_compact_windows      → per-model compaction thresholds; routed models are unknown to the CLI
//                               and would otherwise fall back to 200K.

import type { Config } from "./config.ts";

export const BOOTSTRAP_PATH = "/api/claude_cli/bootstrap";

export function injectBootstrap(body: Buffer, cfg: Config): Buffer {
  const extra = cfg.cli.extraModels;
  const win = cfg.cli.autoCompactWindow;
  if (extra.length === 0 && !win) return body;
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
  if (win) {
    const acw = { ...((j.auto_compact_windows as Record<string, number> | undefined) ?? {}) };
    for (const m of extra) acw[m.model] = win;
    for (const alias of Object.keys(cfg.routes)) acw[alias] = win;
    j.auto_compact_windows = acw;
  }
  return Buffer.from(JSON.stringify(j));
}
