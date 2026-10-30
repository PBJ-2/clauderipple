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
import { bareOwners, ingressOnly, qualifiedModel, rawDeclaredBy, soleOwner } from "./targets.ts";
export { qualifiedModel, declaredBy } from "./targets.ts";
import { isWebFetchRequest } from "./webfetch.ts";
import { webSearchQuery } from "./websearch.ts";

/** What a request is, decided once from its body and path. The order below is the precedence. */
export type RequestKind = "web-search" | "web-fetch" | "auto-mode-classifier" | "turn";

export type Resolved = {
  provider: string;
  model: string;
  effort: string | undefined;
  /** Human tag for the log line, e.g. "claude-opus-4-8->gpt-6-astra". */
  tag: string;
  /** What kind of request this route serves. Adapters read it through `promptAdditions`. */
  kind: RequestKind;
  /** The model id the client asked for, as sent (for example "claude-opus-4-8"). Logs and failover name it. */
  asked: string;
  /** Where this turn goes when the provider above has nothing usable left. Carried from the route. */
  fallbacks?: { provider: string; model: string; effort?: string }[];
  /** Spawn snapshot identity, for worker-only preflight and diagnostics. */
  ladderPick?: string;
};

export function requestKind(json: unknown, pathname: string): RequestKind {
  if (!json || typeof json !== "object") return "turn";
  const request = json as Record<string, unknown>;
  if (pathname === "/v1/messages" && webSearchQuery(request) !== null) return "web-search";
  if (pathname === "/v1/messages" && isWebFetchRequest(request)) return "web-fetch";
  if (isAutoModeClassifier(request)) return "auto-mode-classifier";
  return "turn";
}

export type Decision = { route: Resolved; refusal: null } | { route: null; refusal: string | null };

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// Anchored: the marker is honoured only at the very top of a user message. A subagent prompt starts
// with it; a compaction summary that *quotes* one does not, and on 2026-09-20 such a quote in a
// GPT-6 Astra session's summary re-routed the whole session to `muse` on ChatGPT (400 on every turn).
const MARKER = /^\s*\[\[\s*(?:ripple|gpt)\s*:\s*([A-Za-z0-9._:/\-]+)\s*(?:@\s*([A-Za-z]+))?\s*\]\]/;
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
  const target = aliases[hit.name] ?? hit.name;
  const [model, suffix] = target.split("@");
  const effort = hit.effort ?? suffix;
  return effort ? { model: model!, effort } : { model: model! };
}

/**
 * One pass over the rules: where this request goes, or why it cannot go anywhere. `refusal` is
 * non-null only for a request that must be refused instead of passed through to Anthropic: never for
 * a non-string model, and never when `route` is non-null.
 */
export function decide(model: unknown, body: unknown, cfg: Config, kind: RequestKind): Decision {
  if (typeof model !== "string") return { route: null, refusal: null };
  const routed = (route: Omit<Resolved, "kind" | "asked">): Decision => ({
    route: { ...route, kind, asked: model },
    refusal: null,
  });

  // The engine's own AUTO_MODE_MODEL env var refuses Sonnet 5.5, Opus 5.5 and Opus 5 (CLI 2.1.310),
  // so the target is chosen here. The request kind was matched against the classifier's system
  // prompt before routing; its decision and wire format remain the engine's.
  if (cfg.autoModeClassifier && kind === "auto-mode-classifier") {
    const settings = cfg.autoModeClassifier;
    const stage1 = settings.stage1 !== undefined && isClassifierStage1(body);
    const target = stage1 ? settings.stage1 : settings;
    // A side left out, or a first stage set to "native", falls through to the ordinary routing
    // below, exactly as if the setting were absent.
    if (target !== "native" && target?.provider !== undefined && target.model !== undefined) {
      return routed({
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        tag: `${model}->${target.model} (auto-mode classifier${stage1 ? ", stage 1" : ""})`,
      });
    }
  }

  let base = model;
  let effort: string | undefined;
  const at = model.indexOf("@");
  if (at > 0) {
    base = model.slice(0, at);
    effort = model.slice(at + 1) || undefined;
  }

  const marker = scanMarker(body);
  const aliased = marker ? cfg.aliases[marker.name] : undefined;
  const ov = markerOverride(body, cfg.aliases);
  // The model the request names in the end: the marker's (through its alias), else the requested one.
  const effective = ov?.model ?? base;
  const hasDirect = (id: string): boolean => cfg.direct.some((d) => id.startsWith(d.prefix));

  // Every way below of finding no route ends here, so passing through and refusing are decided by
  // one set of rules, in this order.
  const noRoute = (): Decision => {
    const pass: Decision = { route: null, refusal: null };
    const refuse = (refusal: string): Decision => ({ route: null, refusal });
    // A Claude request still passes through, marker or not: the delegation markers ([[ripple:
    // standard]], [[ripple: opus@high]]) sit on Claude workers and are no model of ours. Only a marker
    // naming a model two providers declare is refused, since passing it on would run it on Claude (#94).
    if (base.startsWith("claude-") && !(marker && rawDeclaredBy(effective, cfg).length > 1)) return pass;
    if (effective.startsWith("claude-") && !qualifiedModel(effective, cfg)) return pass;
    const qualified = qualifiedModel(effective, cfg);
    if (qualified) return ingressOnly(cfg, qualified.provider) ? refuse(`provider "${qualified.provider}" is ingress-only`) : pass;
    // A rule on the requested model decided. A prefix rule honours the marker, so its model counts
    // only when it has no rule of its own; a slot ignores the marker. Either way the only null left is
    // the ingress-only drop, which passes through.
    if (hasDirect(base)) {
      if (effective === base || hasDirect(effective)) return pass;
    } else if (cfg.routes[base] || cfg.routes[base.replace(/-\d{8}$/, "")]) {
      return pass;
    }
    // Otherwise the request would reach Anthropic and come back 404, which is what happened to a whole
    // session on 2026-09-20: an agent file named `deepseek` resolved (through a missing alias) to a
    // model no provider declared, and `PASS` sent thirty of them to Anthropic. Say which name failed.
    const owners = bareOwners(effective, cfg);
    if (owners.length > 1) {
      return refuse(`"${effective}" is declared by two providers (${owners.join(", ")}); use ${owners.map((owner) => `"${owner}:${effective}"`).join(" or ")}, or add a route or direct rule`);
    }
    if (owners.length === 1) return ingressOnly(cfg, owners[0]!) ? refuse(`provider "${owners[0]}" is ingress-only`) : pass;
    if (marker && !aliased) return refuse(`marker alias "${marker.name}" is not an alias and not an agent name`);
    if (aliased) return refuse(`marker alias "${marker!.name}" resolves to "${aliased}", which no provider declares`);
    return refuse(`no provider declares "${effective}"`);
  };

  // Explicit provider spelling selects that declaration, never a competing prefix rule (#94).
  const qualified = qualifiedModel(base, cfg);
  if (qualified) {
    if (ov) {
      const target = decide(`${ov.model}@${ov.effort ?? effort ?? ""}`, {}, cfg, "turn").route;
      return target ? routed({ ...target, tag: `${model}->${target.model} (marker)` }) : noRoute();
    }
    if (ingressOnly(cfg, qualified.provider)) return noRoute();
    return routed({ ...qualified, effort, tag: `${model}->${qualified.model}` });
  }

  const direct = cfg.direct.find((d) => base.startsWith(d.prefix));
  if (direct && ingressOnly(cfg, direct.provider)) return noRoute();
  if (direct) {
    const finalEffort = ov?.effort ?? effort;
    // The provider follows the model the marker names, not the model the session runs on. A
    // `gpt-6-astra` session delegating to `muse` used to keep `chatgpt` as the provider and send
    // it `muse-spark-1.3-contributor`, which ChatGPT refuses (2026-09-20). The marker's model is
    // placed the way any requested model is: its own prefix rule, else its one declaring provider.
    if (effective !== base) {
      const qualified = qualifiedModel(effective, cfg);
      if (qualified) return ingressOnly(cfg, qualified.provider) ? noRoute() : routed({ ...qualified, effort: finalEffort, tag: `${model}->${qualified.model} (marker)` });
      const ownDirect = cfg.direct.find((d) => effective.startsWith(d.prefix));
      const provider = ownDirect ? ownDirect.provider : soleOwner(effective, cfg);
      if (!provider || ingressOnly(cfg, provider)) return noRoute();
      return routed({ provider, model: effective, effort: finalEffort, tag: `${model}->${effective} (marker)` });
    }
    // The log says when a marker decided: `claude-sonnet-5->gpt-6-astra` with no hint of why cost a
    // reporter twenty minutes (issue #13).
    return routed({ provider: direct.provider, model: effective, effort: finalEffort, tag: `${model}->${effective}${ov ? " (marker)" : ""}` });
  }

  // The app sends some slots with a dated id (`claude-haiku-4-5-20251001`) and others without
  // (`claude-opus-5`), while the GUI only ever offers the undated form. Match either.
  const route = cfg.routes[base] ?? cfg.routes[base.replace(/-\d{8}$/, "")];
  if (route) {
    if (ingressOnly(cfg, route.provider)) return noRoute();
    return routed({
      provider: route.provider,
      model: route.model,
      effort: effort ?? route.effort,
      tag: `${model}->${route.model}`,
      // Only a slot has somewhere else to go. A direct rule names one provider on purpose.
      ...(route.fallbacks?.length ? { fallbacks: route.fallbacks } : {}),
    });
  }

  // No rule names this model. A provider that carries it in its own `models` list names it just as
  // plainly: that list is what the probe read from the vendor's `/models` and what the GUI ticked.
  // Not using it was why ticking a model in the GUI did nothing until a `direct` rule was also
  // written by hand, and why one config had eighteen of them (2026-09-19: seventeen of those
  // eighteen are exactly this case). Rules keep their priority — this only fills the gap they
  // leave, so nothing that routes today routes differently.
  const markerTarget = qualifiedModel(effective, cfg);
  if (markerTarget) return ingressOnly(cfg, markerTarget.provider) ? noRoute() : routed({ ...markerTarget, effort: ov?.effort ?? effort, tag: `${model}->${markerTarget.model} (marker)` });
  // A marker's target takes its own prefix rule even when the incoming Claude model had no rule.
  // Prefixes deliberately cover models not declared yet, so ownership alone cannot place it.
  const ownDirect = ov ? cfg.direct.find((d) => effective.startsWith(d.prefix)) : undefined;
  if (ownDirect) {
    if (ingressOnly(cfg, ownDirect.provider)) return noRoute();
    return routed({ provider: ownDirect.provider, model: effective, effort: ov?.effort ?? effort, tag: `${model}->${effective} (marker)` });
  }
  // A metered provider stands back from a bare id another owner declares (targets.ts `bareOwners`).
  const owners = bareOwners(effective, cfg);

  // Two providers offering the same id is a question only the operator can answer (one config has
  // `deepseek-v4-pro` on both a direct DeepSeek mapping and OpenCode Go, and they are not the same
  // deal). Guessing would route someone's traffic to a vendor they did not choose, so an ambiguous
  // id keeps requiring the explicit rule it requires today.
  if (owners.length !== 1) return noRoute();
  const owner = owners[0]!;

  // An ingress-only provider declaring a model does not make it a target: it serves the OpenAI
  // ingress with its own credentials (see `ingressOnly` in targets.ts). This matters more here than
  // anywhere else — a native `anthropic` provider lists the Claude models, and auto-routing those
  // would hijack every Claude request in the session into a provider that answers 400 (ARCHITECTURE
  // §5). Counting it as an owner rather than skipping it is deliberate: if some other provider also
  // offered `claude-opus-5`, that is an ambiguity to be asked about, not a silent redirection of
  // Claude traffic to a third party.
  if (ingressOnly(cfg, owner)) return noRoute();

  return routed({ provider: owner, model: effective, effort: ov?.effort ?? effort, tag: `${model}->${effective}${ov ? " (marker)" : ""}` });
}

/** `decide` for callers that have no path: agents, model scores, the OpenAI ingress. */
export function resolve(model: unknown, body: unknown, cfg: Config): Resolved | null {
  return decide(model, body, cfg, requestKind(body, "/v1/messages")).route;
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
 * `n` is the thinking allowance, 2048 when the classifier model rejects disabled thinking and 0
 * otherwise, so a first stage is at most 2112 and a second stage at least 8192. A larger allowance in
 * a later release would send first stages with the rest, which only costs time; the bound never sends
 * a second stage to the first-stage target. Any other shape goes with the rest too. Call only on a
 * body `isAutoModeClassifier` accepted.
 */
export function isClassifierStage1(body: unknown): boolean {
  const request = body as { stop_sequences?: unknown; max_tokens?: unknown } | null;
  const stops = request?.stop_sequences;
  const max = request?.max_tokens;
  return Array.isArray(stops) && stops.length === 1 && stops[0] === "</block>" && typeof max === "number" && max < 8192;
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
