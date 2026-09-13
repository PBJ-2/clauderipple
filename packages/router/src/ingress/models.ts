// Models the OpenAI ingress can serve to Codex: Claude (native `anthropic` provider) and any
// Anthropic-compatible provider's models, plus the routes that point at them. Shared by
// `GET /v1/models` and by the Codex model catalog that puts these names in the Codex app picker.

import type { Config } from "../config.ts";
import { effortLevels } from "../admin.ts";
import { claudeSupportsEffort } from "./translate.ts";

export type IngressModel = { id: string; name?: string; provider: string; effortLevels: string[] };

export function ingressModels(cfg: Config): IngressModel[] {
  const levels = effortLevels(cfg).providers;
  const out = new Map<string, IngressModel>();
  const add = (id: string, provider: string, name?: string, explicit?: string[]): void => {
    if (out.has(id)) return;
    const p = cfg.providers[provider];
    if (!p || (p.type !== "anthropic" && p.type !== "anthropic-compatible")) return;
    let supported = explicit ?? levels[provider]?.models?.[id] ?? levels[provider]?.default ?? [];
    if (p.type === "anthropic" && !claudeSupportsEffort(id)) supported = [];
    out.set(id, { id, provider, ...(name ? { name } : {}), effortLevels: supported });
  };
  for (const [name, provider] of Object.entries(cfg.providers)) {
    for (const model of provider.models ?? []) add(model.id, name, model.name, model.effortLevels);
  }
  for (const [id, route] of Object.entries(cfg.routes)) {
    const target = cfg.providers[route.provider]?.models?.find((m) => m.id === route.model);
    add(id, route.provider, target?.name, target?.effortLevels);
  }
  return [...out.values()];
}
