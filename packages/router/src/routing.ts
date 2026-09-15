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

  // A native `anthropic` provider serves the OpenAI ingress only; it speaks the Messages API with
  // its own credentials and has nothing to translate for a caller that already speaks it. A rule
  // naming one is ignored here so the request passes through to Anthropic instead of failing.
  const ingressOnly = (name: string): boolean => cfg.providers[name]?.type === "anthropic";

  const direct = cfg.direct.find((d) => base.startsWith(d.prefix));
  if (direct && ingressOnly(direct.provider)) return null;
  if (direct) {
    const ov = markerOverride(body, cfg.aliases);
    const finalModel = ov?.model ?? base;
    const finalEffort = ov?.effort ?? effort;
    return { provider: direct.provider, model: finalModel, effort: finalEffort, tag: `${model}->${finalModel}` };
  }

  // The app sends some slots with a dated id (`claude-haiku-4-5-20251001`) and others without
  // (`claude-opus-5`), while the GUI only ever offers the undated form. Match either.
  const route = cfg.routes[base] ?? cfg.routes[base.replace(/-\d{8}$/, "")];
  if (!route || ingressOnly(route.provider)) return null;
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

// ---- Server-side threads ("tether") -------------------------------------------------
//
// Claude Code 2.1.266 sends `thread: {type:"create"}` on a session's first request and then
// `thread: {type:"continue", previous_message_id}` with ONLY the new messages, expecting the API to
// hold the history (measured 2026-09-13; see docs/ARCHITECTURE.md). Translated providers have no
// such state, so a continue request must be refused with the error code the CLI recognises: it then
// resends the turn stateless and keeps the session stateless on this model ("retry:tether-stateless").
// Accepting the continue instead makes the model see an orphan tool_result and forget the task, and
// kills prompt caching (each turn is a tiny delta with a cold prefix).

export const THREAD_UNSUPPORTED = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "thread: unsupported request — ClaudeRipple routes this model to a provider without server-side threads; resend stateless",
    details: { error_code: "thread_unsupported_request" },
  },
};

/** "refuse" → answer 400 with THREAD_UNSUPPORTED; "strip" → drop thread/diagnostics and proceed. */
export function threadDecision(json: Record<string, unknown>): "refuse" | "strip" | "none" {
  const thread = json.thread as { type?: unknown } | undefined;
  if (!thread || typeof thread !== "object") return "none";
  return thread.type === "continue" ? "refuse" : "strip";
}

export function stripThreadFields(json: Record<string, unknown>): void {
  delete json.thread;
  delete json.diagnostics;
}
