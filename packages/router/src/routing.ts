// Decide, per request, whether the model goes to a provider or straight to Anthropic.
//
//   "claude-opus-4-8"            → routes["claude-opus-4-8"]           (picker-slot alias)
//   "gpt-5.6-sol"                → direct rule by prefix, model unchanged
//   "gpt-5.6-sol@medium"         → same, effort forced to medium
//   "[[ripple: sol@xhigh]]" or "[[gpt: sol@xhigh]]" at the top of the first user
//   message overrides model/effort for direct-rule models only (subagent prompts).

import type { Config } from "./config.ts";

export type Resolved = {
  provider: string;
  model: string;
  effort: string | undefined;
  /** Human tag for the log line, e.g. "claude-opus-4-8->gpt-6-astra". */
  tag: string;
};

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const MARKER = /\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9.\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]/;

type MessageBlock = { type?: string; text?: string };
type Message = { role?: string; content?: string | MessageBlock[] };

export function markerOverride(body: unknown, aliases: Record<string, string>): { model: string; effort?: string } | null {
  const messages = (body as { messages?: Message[] } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  let seen = 0;
  for (const m of messages) {
    if (m?.role !== "user") continue;
    if (++seen > 5) break; // the task prompt is always near the top
    const c = m.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.filter((b) => b && b.type === "text").map((b) => b.text ?? "").join(" ")
        : "";
    const hit = MARKER.exec(text.replace(REMINDER, ""));
    if (hit) {
      const name = hit[1]!.toLowerCase();
      const effort = hit[2]?.toLowerCase();
      return effort ? { model: aliases[name] ?? name, effort } : { model: aliases[name] ?? name };
    }
  }
  return null;
}

export function resolve(model: unknown, body: unknown, cfg: Config): Resolved | null {
  if (typeof model !== "string") return null;
  let base = model;
  let effort: string | undefined;
  const at = model.indexOf("@");
  if (at > 0) {
    base = model.slice(0, at);
    effort = model.slice(at + 1) || undefined;
  }

  const direct = cfg.direct.find((d) => base.startsWith(d.prefix));
  if (direct) {
    const ov = markerOverride(body, cfg.aliases);
    const finalModel = ov?.model ?? base;
    const finalEffort = ov?.effort ?? effort;
    return { provider: direct.provider, model: finalModel, effort: finalEffort, tag: `${model}->${finalModel}` };
  }

  const route = cfg.routes[base];
  if (!route) return null;
  return {
    provider: route.provider,
    model: route.model,
    effort: effort ?? route.effort,
    tag: `${model}->${route.model}`,
  };
}

/** Apply a resolution to a parsed Messages request body (mutates and returns it). */
export function rewriteBody(json: Record<string, unknown>, r: Resolved, effortClamp: Record<string, string>): Record<string, unknown> {
  json.model = r.model;
  const oc = { ...((json.output_config as Record<string, unknown> | undefined) ?? {}) };
  if (r.effort) oc.effort = r.effort;
  if (typeof oc.effort === "string" && effortClamp[oc.effort]) oc.effort = effortClamp[oc.effort];
  if (Object.keys(oc).length > 0) json.output_config = oc;
  return json;
}

export function effortOf(json: Record<string, unknown>): string | undefined {
  const oc = json.output_config as { effort?: unknown } | undefined;
  return typeof oc?.effort === "string" ? oc.effort : undefined;
}
