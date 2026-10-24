// Decide, per request, whether the model goes to a provider or straight to Anthropic.
//
//   "claude-opus-4-8"            → routes["claude-opus-4-8"]           (picker-slot alias)
//   "gpt-5.6-sol"                → direct rule by prefix, model unchanged
//   "gpt-5.6-sol@medium"         → same, effort forced to medium
//   "kimi-k3"                    → the one provider whose `models` carries it, model unchanged
//                                  (only when no rule matched and exactly one provider claims it)
//   "[[ripple: sol@xhigh]]" or "[[gpt: sol@xhigh]]" at the very top of a user
//   message (a subagent prompt) overrides model/effort; the marker's model is then
//   placed by its own prefix rule or its one declaring provider. A slot ignores it.
//   Quoted anywhere else, a marker is prose (issue #13).

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
// Anchored: the marker is honoured only at the very top of a user message. A subagent prompt starts
// with it; a compaction summary that *quotes* one does not, and on 2026-09-20 such a quote in a
// GPT-6 Astra session's summary re-routed the whole session to `muse` on ChatGPT (400 on every turn).
const MARKER = /^\s*\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9.\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]/;
// A Workflow script's agent gets its prompt inside the harness's frame (CLI 2.1.308, 2026-10-22): a
// relayed user request, then one header line ending "The computed task text follows:" and the
// script's text with every line indented. The script's first line is that prompt's top, as a spawned
// subagent's is; read from above the header, a `[[ripple: gemini-3-8-flash@high]]` there was missed
// and eight workers ran on the session's Opus.
const WORKFLOW_TASK = /^\s*\[Workflow harness — computed task\][^\n]*\n/;

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
    const parts = typeof c === "string"
      ? [c]
      : Array.isArray(c)
        ? c.filter((b) => b && b.type === "text").map((b) => b.text ?? "")
        : [];
    // Claude Code may merge the frame's two turns into one message, so each block is looked at alone.
    const framed = parts.map((p) => p.replace(REMINDER, "")).find((p) => WORKFLOW_TASK.test(p));
    const hit = MARKER.exec(parts.join(" ").replace(REMINDER, "")) ?? (framed ? MARKER.exec(framed.replace(WORKFLOW_TASK, "")) : null);
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
  // The engine's own AUTO_MODE_MODEL env var refuses Sonnet 5.5, Opus 5.5 and Opus 5 (CLI 2.1.310),
  // so the target is chosen here. Match the classifier's system prompt, never quoted conversation
  // text. Its decision and wire format remain the engine's; only the inference target changes.
  if (cfg.autoModeClassifier && isAutoModeClassifier(body)) {
    const settings = cfg.autoModeClassifier;
    const stage1 = settings.stage1 !== undefined && isClassifierStage1(body);
    const target = stage1 ? settings.stage1 : settings;
    // A side left out, or a first stage set to "native", falls through to the ordinary routing
    // below, exactly as if the setting were absent.
    if (target !== "native" && target?.provider !== undefined && target.model !== undefined) {
      return {
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        tag: `${model}->${target.model} (auto-mode classifier${stage1 ? ", stage 1" : ""})`,
      };
    }
  }
  let base = model;
  let effort: string | undefined;
  const at = model.indexOf("@");
  if (at > 0) {
    base = model.slice(0, at);
    effort = model.slice(at + 1) || undefined;
  }

  // Native Anthropic stays ingress-only unless the operator explicitly enables its OAuth account
  // pool. That opt-in is what makes routing useful: the same Messages body goes to Anthropic under a
  // selected account, with affinity and failover. Existing configs keep byte-for-byte passthrough.
  const ingressOnly = (name: string): boolean => {
    const provider = cfg.providers[name];
    return provider?.type === "anthropic" && !provider.accountPool;
  };

  const direct = cfg.direct.find((d) => base.startsWith(d.prefix));
  if (direct && ingressOnly(direct.provider)) return null;
  if (direct) {
    const ov = markerOverride(body, cfg.aliases);
    const finalModel = ov?.model ?? base;
    const finalEffort = ov?.effort ?? effort;
    // The provider follows the model the marker names, not the model the session runs on. A
    // `gpt-6-astra` session delegating to `muse` used to keep `chatgpt` as the provider and send
    // it `muse-spark-1.3-contributor`, which ChatGPT refuses (2026-09-20). The marker's model is
    // placed the way any requested model is: its own prefix rule, else its one declaring provider.
    if (finalModel !== base) {
      const ownDirect = cfg.direct.find((d) => finalModel.startsWith(d.prefix));
      const provider = ownDirect ? ownDirect.provider : soleOwner(finalModel, cfg);
      if (!provider || ingressOnly(provider)) return null;
      return { provider, model: finalModel, effort: finalEffort, tag: `${model}->${finalModel} (marker)` };
    }
    // The log says when a marker decided: `claude-sonnet-5->gpt-6-astra` with no hint of why cost a
    // reporter twenty minutes (issue #13).
    return { provider: direct.provider, model: finalModel, effort: finalEffort, tag: `${model}->${finalModel}${ov ? " (marker)" : ""}` };
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
  // A marker's target takes its own prefix rule even when the incoming Claude model had no rule.
  // Prefixes deliberately cover models not declared yet, so ownership alone cannot place it.
  const ownDirect = ov ? cfg.direct.find((d) => finalModel.startsWith(d.prefix)) : undefined;
  if (ownDirect) {
    if (ingressOnly(ownDirect.provider)) return null;
    return { provider: ownDirect.provider, model: finalModel, effort: ov?.effort ?? effort, tag: `${model}->${finalModel} (marker)` };
  }
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

  return { provider: owner, model: finalModel, effort: ov?.effort ?? effort, tag: `${model}->${finalModel}${ov ? " (marker)" : ""}` };
}

export function isAutoModeClassifier(body: unknown): boolean {
  const request = body as { system?: unknown; tools?: unknown } | null;
  if (!request || (Array.isArray(request.tools) && request.tools.length > 0)) return false;
  const system = request.system;
  const texts = typeof system === "string" ? [system] : Array.isArray(system)
    ? system.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text as string)
    : [];
  return texts.some((text) => text.trimStart().startsWith("You are a security monitor for autonomous AI coding agents."));
}

/**
 * The classifier's first stage: a short yes/no that stops at `</block>`, where "no" allows the action
 * and "yes" sends it on to the second stage. CLI 2.1.310 builds it as `max_tokens: 64 + n` with
 * `stop_sequences: ["</block>"]`. The second stage is `8192 + n` with no stop, the server's fast mode
 * (whose "yes" blocks outright) `256 + n` with no stop, and the severity score stops at `</severity>`.
 * `n` is the same on both stages, so the bound never takes in a second stage, and any other shape
 * goes with the rest. Call only on a body `isAutoModeClassifier` accepted.
 */
export function isClassifierStage1(body: unknown): boolean {
  const request = body as { stop_sequences?: unknown; max_tokens?: unknown } | null;
  const stops = request?.stop_sequences;
  const max = request?.max_tokens;
  return Array.isArray(stops) && stops.length === 1 && stops[0] === "</block>" && typeof max === "number" && max < 8192;
}

/**
 * Providers whose own `models` list carries this id. Dated and undated forms match each other, the
 * same way a slot lookup does. Ingress-only providers are included on purpose — see the call site.
 */
/** The one provider declaring this id, or null when none or several do. */
function soleOwner(id: string, cfg: Config): string | null {
  const owners = declaredBy(id, cfg);
  return owners.length === 1 ? owners[0]! : null;
}

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

  const aliased = marker ? cfg.aliases[marker.name] : undefined;
  const effective = aliased ?? (marker ? marker.name : base);
  const hasDirect = (id: string): boolean => cfg.direct.some((d) => id.startsWith(d.prefix));

  // Mirror `resolve`. A prefix rule on the requested model honours the marker: the marker's model is
  // then placed by its own prefix rule or its one declaring provider, and a null from `resolve` there
  // is a real "nowhere to send this". Without a marker, a prefix rule or a slot on the requested model
  // decided, and a null can only be the ingress-only drop — pass through, do not refuse. A slot ignores
  // the marker entirely.
  if (hasDirect(base)) {
    if (effective === base || hasDirect(effective)) return null;
  } else if (cfg.routes[base] || cfg.routes[base.replace(/-\d{8}$/, "")]) {
    return null;
  }

  const owners = declaredBy(effective, cfg);
  if (owners.length > 1) {
    return `"${effective}" is declared by two providers (${owners.join(", ")}); add a route or direct rule`;
  }
  if (owners.length === 1) {
    const owner = owners[0]!;
    const provider = cfg.providers[owner];
    if (provider?.type === "anthropic" && !provider.accountPool) return `provider "${owner}" is ingress-only`;
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

/** The id every translated answer here is given (chatgpt, openai and google translators, web search). */
const MINTED_MESSAGE_ID = /^msg_[0-9a-f]{24}$/;

/**
 * A `continue` of a translated or remembered vendor answer. Compatible vendors mint their own ids;
 * the proxy remembers those as the answer passes. A continue carries only new messages, so a marker is not
 * there to route by: such a request used to pass through to Anthropic, which has no such thread and
 * answers 404, and the CLI resent the whole turn — every turn of every workflow worker (414 in a day,
 * 2026-10-23). The 404 is not the refusal that makes the CLI go stateless; THREAD_UNSUPPORTED is.
 */
export function continuesTranslatedTurn(json: Record<string, unknown>, messageIds?: ReadonlySet<string>): boolean {
  const thread = json.thread as { type?: unknown; previous_message_id?: unknown } | undefined;
  return !!thread && typeof thread === "object" && thread.type === "continue"
    && typeof thread.previous_message_id === "string"
    && (MINTED_MESSAGE_ID.test(thread.previous_message_id) || messageIds?.has(thread.previous_message_id) === true);
}

export function stripThreadFields(json: Record<string, unknown>): void {
  delete json.thread;
  delete json.diagnostics;
}
