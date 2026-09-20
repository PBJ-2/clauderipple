// Decide, per request, whether the model goes to a provider or straight to Anthropic.
//
//   "claude-opus-4-8"            → routes["claude-opus-4-8"]           (picker-slot alias)
//   "gpt-5.6-sol"                → direct rule by prefix, model unchanged
//   "gpt-5.6-sol@medium"         → same, effort forced to medium
//   "kimi-k3"                    → the one provider whose `models` carries it, model unchanged
//                                  (only when no rule matched and exactly one provider claims it)
//   "[[ripple: sol@xhigh]]" or "[[gpt: sol@xhigh]]" at the top of the first user
//   message overrides model/effort for direct-rule models only (subagent prompts).

import type { Config } from "./config.ts";

export type Resolved = {
  provider: string;
  model: string;
  effort: string | undefined;
  /** Human tag for the log line, e.g. "claude-opus-4-8->gpt-6-astra". */
  tag: string;
  /** Where this turn goes when the provider above has nothing usable left. Carried from the route. */
  fallbacks?: { provider: string; model: string; effort?: string }[];
};

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const MARKER = /\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9.\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]/;

type MessageBlock = { type?: string; text?: string };
type Message = { role?: string; content?: string | MessageBlock[] };

/** The raw `[[ripple: <name>@<effort>]]` the body carries, name lowercased. Does not resolve it. */
function scanMarker(body: unknown): { name: string; effort?: string } | null {
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
      return effort ? { name, effort } : { name };
    }
  }
  return null;
}

export function markerOverride(body: unknown, aliases: Record<string, string>): { model: string; effort?: string } | null {
  const hit = scanMarker(body);
  if (!hit) return null;
  const model = aliases[hit.name] ?? hit.name;
  return hit.effort ? { model, effort: hit.effort } : { model };
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
  if (route) {
    if (ingressOnly(route.provider)) return null;
    return {
      provider: route.provider,
      model: route.model,
      effort: effort ?? route.effort,
      tag: `${model}->${route.model}`,
      // Only a slot has somewhere else to go. A direct rule names one provider on purpose.
      ...(route.fallbacks?.length ? { fallbacks: route.fallbacks } : {}),
    };
  }

  // No rule names this model. A provider that carries it in its own `models` list names it just as
  // plainly: that list is what the probe read from the vendor's `/models` and what the GUI ticked.
  // Not using it was why ticking a model in the GUI did nothing until a `direct` rule was also
  // written by hand, and why one config had eighteen of them (2026-09-19: seventeen of those
  // eighteen are exactly this case). Rules keep their priority — this only fills the gap they
  // leave, so nothing that routes today routes differently.
  const ov = markerOverride(body, cfg.aliases);
  const finalModel = ov?.model ?? base;
  const owners = declaredBy(finalModel, cfg);

  // Two providers offering the same id is a question only the operator can answer (one config has
  // `deepseek-v4-pro` on both a direct DeepSeek mapping and OpenCode Go, and they are not the same
  // deal). Guessing would route someone's traffic to a vendor they did not choose, so an ambiguous
  // id keeps requiring the explicit rule it requires today.
  if (owners.length !== 1) return null;
  const owner = owners[0]!;

  // An ingress-only provider declaring a model does not make it a target: it serves the OpenAI
  // ingress with its own credentials (see `ingressOnly` above). This matters more here than
  // anywhere else — a native `anthropic` provider lists the Claude models, and auto-routing those
  // would hijack every Claude request in the session into a provider that answers 400 (ARCHITECTURE
  // §5). Counting it as an owner rather than skipping it is deliberate: if some other provider also
  // offered `claude-opus-5`, that is an ambiguity to be asked about, not a silent redirection of
  // Claude traffic to a third party.
  if (ingressOnly(owner)) return null;

  return { provider: owner, model: finalModel, effort: ov?.effort ?? effort, tag: `${model}->${finalModel}` };
}

/**
 * Providers whose own `models` list carries this id. Dated and undated forms match each other, the
 * same way a slot lookup does. Ingress-only providers are included on purpose — see the call site.
 */
export function declaredBy(id: string, cfg: Config): string[] {
  const undated = id.replace(/-\d{8}$/, "");
  const owners: string[] = [];
  for (const [name, provider] of Object.entries(cfg.providers)) {
    const models = provider.models;
    if (!models?.length) continue;
    if (models.some((m) => m.id === id || m.id === undated || m.id.replace(/-\d{8}$/, "") === undated)) owners.push(name);
  }
  return owners;
}

/**
 * Why `resolve` returned null, named, or null when the request is not ours to refuse.
 *
 * A model that resolves needs no explanation. A native Claude id is deliberately unrouted — it
 * passes through to Anthropic — so it is never a refusal either. Everything else reaching here is a
 * request that would otherwise be forwarded to Anthropic and come back 404, which is what happened
 * to a whole session on 2026-09-20: an agent file named `deepseek` resolved (through a missing
 * alias) to a model no provider declared, and `PASS` sent thirty of them to Anthropic.
 *
 * Pure: it decides and explains, it does not send.
 */
export function unroutableReason(model: unknown, body: unknown, cfg: Config): string | null {
  if (typeof model !== "string") return null;
  if (model.startsWith("claude-")) return null;

  const at = model.indexOf("@");
  const base = at > 0 ? model.slice(0, at) : model;
  const marker = scanMarker(body);

  // A rule decides first, and `resolve` already honoured it — a null here means the rule is one it
  // drops on purpose (an ingress-only provider), which the request should pass through, not refuse.
  // Rules are keyed on the model the request names, never on the marker.
  if (cfg.direct.some((d) => base.startsWith(d.prefix))) return null;
  if (cfg.routes[base] || cfg.routes[base.replace(/-\d{8}$/, "")]) return null;

  // No rule. `resolve` now consults the marker, then the providers' own `models` lists. Mirror it.
  const aliased = marker ? cfg.aliases[marker.name] : undefined;
  const effective = aliased ?? (marker ? marker.name : base);

  const owners = declaredBy(effective, cfg);
  if (owners.length > 1) {
    return `"${effective}" is declared by two providers (${owners.join(", ")}); add a route or direct rule`;
  }
  if (owners.length === 1) {
    const owner = owners[0]!;
    if (cfg.providers[owner]?.type === "anthropic") return `provider "${owner}" is ingress-only`;
    return null; // resolve() would have routed this; nothing to refuse.
  }
  // Nothing declares it. Say which name failed, and whether a marker introduced it.
  if (marker && !aliased) return `marker alias "${marker.name}" is not an alias and not an agent name`;
  if (aliased) return `marker alias "${marker!.name}" resolves to "${aliased}", which no provider declares`;
  return `no provider declares "${effective}"`;
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
