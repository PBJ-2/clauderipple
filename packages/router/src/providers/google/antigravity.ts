// Google Antigravity / Cloud Code Assist (CCA): the wire facts, model-id resolution and the
// conversation session id this router uses. Kept apart from the account store (accounts.ts) and the
// OAuth session (login.ts) so each can be read and tested on its own.
//
// Every fact here is taken from the reference implementation opencodex (GitHub lidge-jun/opencodex,
// read 2026-10-01 as a behavioral spec — no code copied; the project rule forbids copying it). Each
// constant names its source file:line in a comment. **Nothing here is measured against a live
// Google endpoint** — this environment has no Antigravity subscription, so the whole file is
// doc/source-derived and unmeasured. That is recorded in docs/ARCHITECTURE.md §4d.

import crypto from "node:crypto";
import type { ProviderModel } from "../../config.ts";

// ── OAuth + Cloud Code Assist endpoints ─────────────────────────────────────────────────────────

/**
 * The public OAuth client embedded in the Antigravity desktop client. These are client identifiers,
 * not user secrets: opencodex ships them in the clear and they are overridable by environment there.
 * Source: opencodex `src/oauth/google-antigravity.ts:17-38`.
 */
export const GOOGLE_OAUTH = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  /** Project discovery (`loadCodeAssist`) is served by the prod host. */
  prodApi: "https://cloudcode-pa.googleapis.com",
  /** Streaming and `onboardUser` use the daily host. Source: opencodex `src/oauth/google-antigravity.ts:24-25`. */
  dailyApi: "https://daily-cloudcode-pa.googleapis.com",
  /** The two Cloud Code Assist hosts. They offer different models and count quota separately. */
  hosts: ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"] as const,
  apiVersion: "v1internal",
  /** Preferred loopback port; the callback path is fixed. Source: opencodex `src/oauth/google-antigravity.ts:34-35`. */
  port: 51121,
  callbackPath: "/callback",
  /** Refresh this long before the access token expires. Source: opencodex `REFRESH_SKEW_MS`. */
  refreshLeadMs: 5 * 60 * 1000,
  /** How long a sign-in may stay open. Same as the other sign-in flows. */
  timeoutMs: 5 * 60 * 1000,
  requestTimeoutMs: 30_000,
} as const;

/**
 * The terms warning the CLI prints once and the admin API returns in a `warning` field. Facts only:
 * Google's Antigravity terms (clause 6) and the Gemini CLI FAQ state that using these credentials
 * from a third-party client is a violation, and Google blocked a large number of accounts in
 * February 2026. ClaudeRipple is not affiliated with Google.
 */
export const ANTIGRAVITY_WARNING =
  "Google's Antigravity terms (section 6) and the Gemini CLI FAQ say that using these credentials " +
  "from a client other than Google's own is not permitted, and Google blocked a large number of " +
  "accounts used this way in February 2026. ClaudeRipple is not affiliated with Google. Sign in only " +
  "if you accept that risk.";

/** Antigravity IDE version, mirrored so the request fingerprint matches the token's client. */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";

/**
 * The User-Agent the real Antigravity IDE sends. The CCA backend gates newer agent models on the
 * `antigravity/ide/...` client family and answers 404 to CLI-shaped UAs even with a valid OAuth
 * token. Source: opencodex `src/adapters/client-fingerprint.ts:44-65`, decompiled from the 2.5.5
 * language server.
 */
export function antigravityUserAgent(): string {
  const override = process.env.CLAUDERIPPLE_ANTIGRAVITY_USER_AGENT?.trim() || process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (override) return override;
  const [osType, arch] = "windows/amd64".split("/");
  return `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`;
}

/** Antigravity CLI version whose User-Agent CCA serves Gemini 4 Argon to. Source: opencodex `ANTIGRAVITY_CLI_VERSION`. */
export const ANTIGRAVITY_CLI_VERSION = "1.3.4";

/**
 * The User-Agent the Antigravity CLI sends. CCA serves Gemini 4 Argon only to this client family:
 * `fetchAvailableModels` lists `gemini-4-argon-{low,medium,high}` under it and not under the IDE UA
 * (measured 2026-10-27 on both hosts, one Google AI Pro account), and opencodex measured Argon requests 404
 * under the IDE UA while `gemini-3.7-flash-tiered` and `gemini-3.1-pro-low` 404 under this one. So it
 * is used for Argon generation and the quota summary, not other models' generation. The IDE
 * override does not apply: it names the IDE header, and letting it replace this one would lock
 * Argon again. Source: opencodex
 * `src/adapters/client-fingerprint.ts antigravityCliUserAgent`.
 */
export function antigravityCliUserAgent(): string {
  const [osType, arch] = "windows/amd64".split("/");
  return `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`;
}

/**
 * True for the models CCA serves only to the CLI client family, as a base or wire id: Gemini 4 Argon
 * and Gemini 4 Hydrogen. Hydrogen measured 2026-11-13, one Google AI Pro account: the daily host's
 * CLI catalogue lists `gemini-4-hydrogen-{low,medium,high,xhigh}` and the IDE one does not; each
 * tier answers 200 under the CLI UA and `-medium` 404s under the IDE UA.
 */
function servedToCliByName(model: string): boolean {
  return /^gemini-4-(?:argon|hydrogen)(?:-|$)/.test(model);
}

/**
 * True for the models CCA serves only to the CLI client family, as a base or wire id: the two named
 * above, and any Gemini model outside the tables that the provider's catalogue showed to be one
 * (`LearnedCatalogue.cliOnly`: some CLI answer lists it and no IDE answer does).
 */
export function servedToAntigravityCli(model: string, learned?: LearnedCatalogue): boolean {
  if (servedToCliByName(model)) return true;
  return !isStaticId(model) && learned?.cliOnly(model) === true;
}

/** The User-Agent a generation request for `model` (a base or wire id) must carry. */
export function antigravityUserAgentFor(model: string, learned?: LearnedCatalogue): string {
  return servedToAntigravityCli(model, learned) ? antigravityCliUserAgent() : antigravityUserAgent();
}

// ── Model id resolution ─────────────────────────────────────────────────────────────────────────

/**
 * Normalise a Claude Code effort onto Cloud Code Assist's three thinking levels. `xhigh`, `max` and
 * `ultra` all clamp to `high`; `none`/`minimal` to `low`. `minimal` is not itself a CCA level.
 * Source: opencodex `src/providers/antigravity-models.ts:resolveAntigravityThinkingLevel`.
 */
export function resolveAntigravityThinkingLevel(effort: string | undefined): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "none":
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "xhigh":
    case "max":
    case "ultra": return "high";
    default: return undefined;
  }
}

/**
 * Base models whose every effort rides on a different wire id that already names the tier. Here the
 * suffix IS the effort, so no `thinkingConfig` is sent beside it. Source: opencodex
 * `ANTIGRAVITY_EFFORT_WIRE_MAP` / `ANTIGRAVITY_SUFFIX_TIER_MODELS`.
 */
const SUFFIX_TIER_MODELS: Record<string, { wire: Record<string, string>; default: string }> = {
  // High rides on the medium tier: `-high` thinks with no budget (the catalogue's thinkingBudget -1,
  // against 4000 for medium), and on 2026-10-17 the requests past 4000 output tokens took 64% of all
  // request time. The owner chose speed over the deeper tier (2026-10-20). `-high` named outright
  // still goes through as it is.
  "gemini-3.8-flash": {
    wire: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-medium" },
    default: "medium",
  },
  // Medium is Argon's own default level (translate.ts, Gemini API thinking guide). Only the CLI
  // client family is served these ids (`antigravityCliUserAgent`).
  "gemini-4-argon": {
    wire: { low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high" },
    default: "medium",
  },
  // Measured 2026-11-13 (daily host, CLI UA): four tiers, each answering without a `thinkingLevel`;
  // the bare `gemini-4-hydrogen` 404s. `xhigh` is a tier of its own here, so it and everything above
  // it take that rung instead of clamping to high. Medium by default, as for Argon (a choice, not a
  // measurement: the catalogue names no default tier for Hydrogen).
  "gemini-4-hydrogen": {
    wire: {
      low: "gemini-4-hydrogen-low", medium: "gemini-4-hydrogen-medium", high: "gemini-4-hydrogen-high",
      xhigh: "gemini-4-hydrogen-xhigh", max: "gemini-4-hydrogen-xhigh", ultra: "gemini-4-hydrogen-xhigh",
    },
    default: "medium",
  },
};

/**
 * Base models whose efforts map to wire ids but where a `thinkingConfig.thinkingLevel` also travels
 * (the high rung `gemini-pro-agent` carries no tier in its name). Source: opencodex
 * `ANTIGRAVITY_EFFORT_WIRE_MAP` / `ANTIGRAVITY_MODEL_EFFORTS`.
 */
const EFFORT_WIRE_MODELS: Record<string, { wire: Record<string, string>; default: string }> = {
  "gemini-3.1-pro": { wire: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" }, default: "high" },
};

/**
 * Base models whose effort rides on a single `-tiered` wire id via `thinkingLevel`. Source:
 * opencodex `ANTIGRAVITY_THINKING_LEVEL_MODELS` / `ANTIGRAVITY_PICKER_TO_WIRE`.
 */
const THINKING_LEVEL_MODELS: Record<string, { wire: string; default: string }> = {
  "gemini-3.7-flash": { wire: "gemini-3.7-flash-tiered", default: "medium" },
};

/** A table's own entry for `key`: an id such as `constructor` must not find Object.prototype's. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export type AntigravityWireModel = {
  /** The id the CCA envelope's `model` field must carry. */
  wire: string;
  /** The thinking level to place on `request.generationConfig.thinkingConfig`, when this model takes one. */
  thinkingLevel?: "low" | "medium" | "high";
  /** True when this base id is one this module knows; an unknown id is forwarded verbatim and untouched. */
  known: boolean;
};

/**
 * Resolve a Claude Code model id onto the Cloud Code Assist wire id and thinking level. A base id
 * (`gemini-3.8-flash`) resolves to its tier wire id; an id already naming a tier is forwarded as it
 * is. Unknown ids pass through untouched so a model Google adds tomorrow is still directly routable.
 */
export function resolveAntigravityWireModel(model: string, effort: string | undefined, learned?: LearnedCatalogue): AntigravityWireModel {
  const level = resolveAntigravityThinkingLevel(effort);
  const suffix = own(SUFFIX_TIER_MODELS, model);
  if (suffix) {
    // The effort as asked is looked up first: a model with a tier above high (Hydrogen's `-xhigh`)
    // names it in its own map, and every other model falls to the three clamped levels.
    const wire = (effort && Object.hasOwn(suffix.wire, effort) && suffix.wire[effort]) || (level && suffix.wire[level]) || suffix.wire[suffix.default]!;
    // The suffix names the tier; sending `thinkingLevel` beside it would state the effort twice.
    return { wire, known: true };
  }
  const mapped = own(EFFORT_WIRE_MODELS, model);
  if (mapped) {
    const wire = (level && mapped.wire[level]) || mapped.wire[mapped.default]!;
    return { wire, ...(level ? { thinkingLevel: level } : {}), known: true };
  }
  const tiered = own(THINKING_LEVEL_MODELS, model);
  if (tiered) {
    return { wire: tiered.wire, thinkingLevel: (level ?? tiered.default) as "low" | "medium" | "high", known: true };
  }
  // A base id whose tier ids the provider's catalogue showed (below): the suffix names the tier, as
  // for the families above. Asked again on every turn, so it ends the moment its bare id is listed,
  // and it holds while one tier is left (`LearnedCatalogue.tiers`).
  const tiers = learned?.tiers(model);
  if (tiers) return { wire: `${model}-${tierFor(tiers, effort)}`, known: true };
  // Claude models on Antigravity take effort through thinkingConfig only, no suffix — CCA validates
  // the field against Google's ThinkingLevel enum. Source: opencodex rule 4.
  if (/^claude-/.test(model)) return { wire: model, ...(level ? { thinkingLevel: level } : {}), known: true };
  return { wire: model, known: false };
}

// ── Models learned from the catalogue ───────────────────────────────────────────────────────────

/**
 * The tiers a wire id's suffix may name, lowest first. Measured 2026-11-13 (daily host, CLI answer,
 * one Google AI Pro account): every tier id carries its own numeric `thinkingLevel` in the catalogue
 * (`-low` 1, `-medium` 2, `-high` 3, `-xhigh` 100), for Flash 3.8, Argon and Hydrogen alike, so the
 * id is what states the level.
 */
const TIERS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TIER_SUFFIX = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;
/** The efforts a Claude Code picker can show; `minimal` is a wire tier only. */
const PICKER_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Wire ids the tables send that no tier suffix leads back to a base id (`gemini-pro-agent`). */
const STATIC_WIRE_IDS: ReadonlySet<string> = new Set([
  ...Object.values(SUFFIX_TIER_MODELS).flatMap((m) => Object.values(m.wire)),
  ...Object.values(EFFORT_WIRE_MODELS).flatMap((m) => Object.values(m.wire)),
  ...Object.values(THINKING_LEVEL_MODELS).map((m) => m.wire),
]);

/** Every base and wire id the hand-written tables name. */
function isStaticId(id: string): boolean {
  return isBaseModel(collapseWireId(id)) || STATIC_WIRE_IDS.has(id);
}

/**
 * The tier a learned family runs an effort on: the tier asked for, else the nearest one below it,
 * else the nearest above (`xhigh` on a three-tier family takes `high`, as the clamp above does).
 * Without an effort it is `medium`, the default chosen for Argon and Hydrogen, by the same rule.
 */
function tierFor(tiers: readonly string[], effort: string | undefined): string {
  const asked = effort === "none" ? "minimal" : effort === "ultra" ? "max" : effort;
  const at = (TIERS as readonly string[]).indexOf(asked && (TIERS as readonly string[]).includes(asked) ? asked : "medium");
  for (let i = at; i >= 0; i--) if (tiers.includes(TIERS[i]!)) return TIERS[i]!;
  for (let i = at + 1; i < TIERS.length; i++) if (tiers.includes(TIERS[i]!)) return TIERS[i]!;
  return tiers[0]!;
}

/**
 * What a provider's catalogue listed, per host and per client family: the agent-callable ids
 * outside the tables, as the answers gave them. `cli` is absent while that host's CLI ask has never
 * answered. This is the whole of what is kept; everything else is worked out from it.
 */
export type LearnedSnapshot = Record<string, { ide?: string[]; cli?: string[] }>;
type LearnedLists = { ide?: string[]; cli?: string[] };

const LEARNED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEARNED_MAX_IDS = 500;
const LEARNED_MAX_HOSTS = 8;

/** Ids as kept: well-formed, outside the tables, once each, in a stable order. */
function learnedIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !LEARNED_ID.test(id) || isStaticId(id)) continue;
    ids.add(id);
    if (ids.size >= LEARNED_MAX_IDS) break;
  }
  return [...ids].sort();
}

/**
 * The models one provider learned from its catalogue instead of from the tables above. Google adds
 * models without notice (Argon 2026-10, Hydrogen 2026-11-12), and each one needed its id typed into
 * five tables here before it could be listed or called. The catalogue already says what those
 * tables said (measured 2026-11-13, docs/ARCHITECTURE.md §4d-ii "Models outside the tables"), so
 * the lists it gave are kept as they were and three things are read off them, for `gemini-` ids:
 * - a tier family: a base that is not itself listed, with at least two tier ids listed;
 * - the client family: an id some CLI answer lists and no IDE answer lists is served to the CLI
 *   family only, so its requests carry the CLI User-Agent. An id any host's IDE answer lists goes
 *   to such a host under the IDE User-Agent, as every model outside the tables always did;
 * - the hosts that list a wire id.
 * An id in the tables is never kept here and never looked up here: what was measured for it by hand
 * stays as written. The same holds for what the hand-written rules cover: a `claude-*` or other
 * non-Gemini id is offered and sent exactly as before (listed when an IDE answer lists it, IDE
 * User-Agent, `3p` scope for Claude and GPT-OSS). One instance per provider: two providers may pin
 * different hosts, and each keeps only the hosts it asks. The accounts are the home's, so a host
 * answers every provider alike, which is why a provider with no lists of its own may start from
 * what another kept for the same host (`GoogleAdapter`).
 */
export class LearnedCatalogue {
  /** Replaced whole by `take`, never changed in place, so a `view` stays what it was. */
  private hosts: ReadonlyMap<string, LearnedLists> = new Map();
  /** The hosts this provider asks; lists of any other host are never kept. Undefined: any host. */
  private readonly asked: readonly string[] | undefined;
  /** Every id some IDE answer lists and every id some CLI answer lists, for the `hosts` they were built from. */
  private index: { of: ReadonlyMap<string, LearnedLists>; ide: Set<string>; cli: Set<string> } | undefined;

  /**
   * From a stored snapshot, for a provider that asks `asked` (a provider that pins a host keeps only
   * that host's lists, so a tier another host listed is never sent to the pinned one). Every entry
   * is checked on the way in; anything malformed, or of a host not asked, is left out.
   */
  constructor(snapshot?: unknown, asked?: readonly string[]) {
    this.asked = asked?.map((host) => host.replace(/\/+$/, ""));
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
    const hosts = new Map<string, LearnedLists>();
    for (const [host, lists] of Object.entries(snapshot as Record<string, unknown>)) {
      if (hosts.size >= LEARNED_MAX_HOSTS) break;
      if (!this.keeps(host) || !lists || typeof lists !== "object" || Array.isArray(lists)) continue;
      const ide = learnedIds((lists as { ide?: unknown }).ide);
      const cli = learnedIds((lists as { cli?: unknown }).cli);
      if (ide || cli) hosts.set(host, { ...(ide ? { ide } : {}), ...(cli ? { cli } : {}) });
    }
    this.hosts = hosts;
  }

  private keeps(host: string): boolean {
    return this.asked ? this.asked.includes(host) : host.length > 0 && host.length <= 200;
  }

  /**
   * The lists as they stand now, unaffected by any later `take`. One turn resolves its wire id,
   * host, User-Agent and quota scope, and reads Google's refusal, against one view: a catalogue
   * read that lands while the turn is in flight must not make its 429 name another scope than the
   * one the turn was started under.
   */
  view(): LearnedCatalogue {
    const copy = new LearnedCatalogue(undefined, this.asked);
    copy.hosts = this.hosts;
    return copy;
  }

  /**
   * Take in one read: for each host that answered, the ids its IDE answer listed replace the ones
   * kept, and so do its CLI answer's when that ask answered. An ask or a host that did not answer
   * says nothing, so what it listed last time stays. Returns whether anything changed.
   */
  take(read: ReadonlyMap<string, { ide: readonly string[]; cli?: readonly string[] }>): boolean {
    const hosts = new Map(this.hosts);
    let changed = false;
    for (const [rawHost, clients] of read) {
      const host = rawHost.replace(/\/+$/, "");
      if (!this.keeps(host) || (!hosts.has(host) && hosts.size >= LEARNED_MAX_HOSTS)) continue;
      const cli = clients.cli ? learnedIds(clients.cli) : hosts.get(host)?.cli;
      const next = { ide: learnedIds(clients.ide) ?? [], ...(cli ? { cli } : {}) };
      if (JSON.stringify(hosts.get(host)) === JSON.stringify(next)) continue;
      hosts.set(host, next);
      changed = true;
    }
    if (changed) this.hosts = hosts;
    return changed;
  }

  /** The kept lists, hosts in a stable order, so two snapshots of the same lists compare equal as JSON. */
  snapshot(): LearnedSnapshot {
    return Object.fromEntries([...this.hosts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([host, lists]) => [host, { ...(lists.ide ? { ide: [...lists.ide] } : {}), ...(lists.cli ? { cli: [...lists.cli] } : {}) }]));
  }

  private all(): { ide: Set<string>; cli: Set<string> } {
    if (this.index?.of !== this.hosts) {
      const ide = new Set<string>();
      const cli = new Set<string>();
      for (const lists of this.hosts.values()) {
        for (const id of lists.ide ?? []) ide.add(id);
        for (const id of lists.cli ?? []) cli.add(id);
      }
      this.index = { of: this.hosts, ide, cli };
    }
    return this.index;
  }

  private listed(id: string): boolean {
    const all = this.all();
    return all.ide.has(id) || all.cli.has(id);
  }

  /**
   * The tiers `base` collapses, lowest first, or undefined when it is not a family. Two tiers,
   * because one suffixed id alone may be a whole model name (`gpt-oss-120b-medium` is); not when
   * the bare id is itself listed, because then it is a model and the suffixed ids are others.
   * Gemini only: `claude-opus-5-5-low/medium/high` carry a `thinkingLevel` each too (measured
   * 2026-11-13), but they are separate picker rows here and existing configurations name them.
   */
  family(base: string): string[] | undefined {
    const tiers = this.tiers(base);
    return tiers && tiers.length >= 2 ? tiers : undefined;
  }

  /**
   * The tier ids listed for `base`, lowest first, when `base` itself is not listed: what a request
   * for `base` resolves onto. One is enough here, where `family` (what the list collapses) wants
   * two: a family that Google cut to one tier is no longer offered as a ladder, but the base id a
   * configuration saved while it was one must keep reaching the tier that is left. Forwarded as it
   * is, it would name an id no host lists. So routing, the client family and the quota scope all
   * ask this, and only the list asks `family`.
   */
  tiers(base: string): string[] | undefined {
    if (!base.startsWith("gemini-") || isStaticId(base) || this.listed(base)) return undefined;
    const tiers = TIERS.filter((t) => this.listed(`${base}-${t}`));
    return tiers.length ? tiers : undefined;
  }

  /** Google's hosts that some kept list names, in preference order. */
  knownHosts(): string[] {
    return GOOGLE_OAUTH.hosts.filter((host) => {
      const lists = this.hosts.get(host);
      return !!lists && ((lists.ide?.length ?? 0) > 0 || (lists.cli?.length ?? 0) > 0);
    });
  }

  /** The base id that `id` (a base id, or one of its tier ids) is routed and rested under. */
  familyOf(id: string): string | undefined {
    if (this.tiers(id)) return id;
    const match = TIER_SUFFIX.exec(id);
    return match && this.tiers(match[1]!)?.includes(match[2]!) ? match[1]! : undefined;
  }

  /** The collapsed row `id` is listed under: its base id when the list collapses that base. */
  private rowOf(id: string): string {
    const match = TIER_SUFFIX.exec(id);
    return match && this.family(match[1]!)?.includes(match[2]!) ? match[1]! : id;
  }

  /** A `gemini-` wire id that some CLI answer lists and no IDE answer does. */
  private wireCliOnly(id: string): boolean {
    const all = this.all();
    return id.startsWith("gemini-") && all.cli.has(id) && !all.ide.has(id);
  }

  /**
   * Whether requests for `id` need the CLI User-Agent: a Gemini wire id that only CLI answers list.
   * A family's base id: when every tier does. One answer for every host, because an id that any
   * host's IDE answer lists is only ever offered on, and sent to, such a host (`hostOf`,
   * `catalogueFrom`).
   */
  cliOnly(id: string): boolean {
    const tiers = this.tiers(id);
    return tiers ? tiers.every((t) => this.wireCliOnly(`${id}-${t}`)) : this.wireCliOnly(id);
  }

  /**
   * The pool scope of a learned Gemini model served to the CLI family alone, in whole or in part:
   * its own, named for its family and shared by its base id and every tier of it. Nothing is known
   * about the bucket such a model draws on (Argon has one of its own on Pro, Hydrogen's is
   * unmeasured), so, as for Hydrogen, proof that it is spent rests only it and the ordinary Gemini
   * windows are never its positive-quota evidence. A learned model whose every wire id an IDE answer
   * lists keeps the `gemini` scope.
   */
  cliScope(id: string): string | undefined {
    if (!id.startsWith("gemini-") || isStaticId(id) || servedToCliByName(id)) return undefined;
    const family = this.familyOf(id);
    const wires = family ? this.tiers(family)!.map((t) => `${family}-${t}`) : [id];
    return wires.some((w) => this.wireCliOnly(w)) ? (family ?? id) : undefined;
  }

  /**
   * The host a wire id outside the tables goes to: the first of Google's two whose IDE answer
   * lists it, else, for an id served to the CLI family alone, the first whose CLI answer does. The
   * same lists choose the User-Agent (`wireCliOnly`), so the two always agree, and the adapter asks
   * this before its host map (`GoogleAdapter.hostFor`). Only those two hosts are ever returned,
   * whatever a stored snapshot names: a host is where the account's token is sent.
   */
  hostOf(wire: string): string | undefined {
    const lists = (host: string): LearnedLists | undefined => this.hosts.get(host);
    return GOOGLE_OAUTH.hosts.find((host) => lists(host)?.ide?.includes(wire))
      ?? (this.wireCliOnly(wire) ? GOOGLE_OAUTH.hosts.find((host) => lists(host)?.cli?.includes(wire)) : undefined);
  }

  /**
   * One row per learned model, for the list of a catalogue that cannot be read: what an IDE answer
   * listed, and the Gemini ids served to the CLI family alone. The same ids a readable catalogue
   * offers.
   */
  rows(): ProviderModel[] {
    const all = this.all();
    const ids = new Set<string>();
    for (const id of all.ide) ids.add(this.rowOf(id));
    for (const id of all.cli) if (this.wireCliOnly(id)) ids.add(this.rowOf(id));
    return [...ids].sort().map((id) => {
      const efforts = (this.family(id) ?? []).filter((t) => PICKER_EFFORTS.includes(t));
      return { id, ...(efforts.length ? { effortLevels: efforts } : {}) };
    });
  }
}

/**
 * The conversation's Cloud Code Assist session id. The real client puts one stable id on every turn
 * of a conversation so provider-side replay can associate a thoughtSignature with the call that
 * produced it; an unstable id loses that association. We derive it from `conversationKey`, which the
 * router already keeps stable per conversation (and identical to the prompt-cache key), and shape it
 * as the numeric string the wire carries — `sha256(key)` → BigEndian uint64 masked to 63 bits, with a
 * leading "-". Source: opencodex `antigravitySessionId` (CLIProxyAPI `generateStableSessionID`).
 */
export function antigravitySessionId(conversationKey: string): string {
  const digest = crypto.createHash("sha256").update(conversationKey, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

/** A fresh per-request id, as the envelope's `requestId`. Source: opencodex `agent-${uuid}`. */
export function antigravityRequestId(): string {
  return `agent-${crypto.randomUUID()}`;
}

// ── Model catalogue ─────────────────────────────────────────────────────────────────────────────

/**
 * Context windows per model, from CCA's own `maxTokens` for the wire ids. Source: opencodex
 * `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS`.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-4-argon": 1_048_576,
  "gemini-4-hydrogen": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  "gemini-3.1-flash-image": 1_048_576,
  "claude-sonnet-4-6": 250_000,
  "claude-opus-4-6-thinking": 250_000,
  "gpt-oss-120b-medium": 131_072,
};

/**
 * The effort ladder per collapsed base model, for the GUI. The suffix-tier model's rungs are wire
 * ids, so the GUI shows them as one entry with a ladder rather than three rows (opencodex does the
 * same collapsing). Source: opencodex `ANTIGRAVITY_MODEL_EFFORTS`.
 */
const EFFORT_LEVELS: Record<string, string[]> = {
  "gemini-4-argon": ["low", "medium", "high"],
  "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high"],
  "claude-opus-4-6-thinking": ["low", "medium", "high"],
};

/** The collapsed base models the CCA backend serves. Source: opencodex `ANTIGRAVITY_MODELS`. */
export const ANTIGRAVITY_BASE_MODELS = [
  // First stays a model every account is served under the IDE UA: the verification recheck pings
  // the first static model when the provider lists none.
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-4-hydrogen",
  "gemini-3.7-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

/** The static fallback list, used when `:fetchAvailableModels` cannot be read. */
export function staticAntigravityModels(): ProviderModel[] {
  return ANTIGRAVITY_BASE_MODELS.map((id) => ({
    id,
    ...(CONTEXT_WINDOWS[id] ? { contextWindow: CONTEXT_WINDOWS[id] } : {}),
    ...(EFFORT_LEVELS[id] ? { effortLevels: [...EFFORT_LEVELS[id]] } : {}),
  }));
}

function isBaseModel(id: string): boolean {
  return (ANTIGRAVITY_BASE_MODELS as readonly string[]).includes(id);
}

/**
 * Collapse a wire id back to the collapsed base id the picker shows, when it names a known tier. The
 * collapsed id is what the static catalogue lists and what `resolveAntigravityWireModel` maps back to
 * a wire id, so the picker shows one row per model and routing is the same whether the list came from
 * discovery or the fallback.
 */
function collapseWireId(wireId: string): string {
  if (isBaseModel(wireId)) return wireId;
  const tiered = wireId.endsWith("-tiered") ? wireId.slice(0, -"-tiered".length) : undefined;
  if (tiered && isBaseModel(tiered)) return tiered;
  const match = /^(.*)-(low|medium|high|xhigh|max|minimal)$/.exec(wireId);
  if (match && isBaseModel(match[1]!)) return match[1]!;
  return wireId;
}

/**
 * One host's catalogue: the picker rows and the wire ids they were collapsed from. `families` names
 * the learned tier families among the rows (base id → tiers, lowest first), and `clients` the
 * agent ids outside the tables that each client family's answer listed, for `LearnedCatalogue.take`
 * (`cli` is absent when that ask did not answer).
 */
export type ParsedHostCatalogue = { models: ProviderModel[]; wireIds: string[]; families?: Record<string, string[]>; clients?: { ide: string[]; cli?: string[] } };

/** One answer of `fetchAvailableModels`: the agent-callable ids in listing order, and what `models{}` says of each. */
/**
 * The most ids one answer is read for; a measured answer lists under twenty. The same bound as the
 * lists a provider keeps, so a kept list is never a truncated answer: `LearnedCatalogue.hostOf`
 * reads an id missing from a host's list as that host not listing it.
 */
const ANSWER_MAX_IDS = LEARNED_MAX_IDS;

type CatalogueAnswer = { listed: string[]; info: Record<string, unknown> };

/**
 * Read one `POST {host}/v1internal:fetchAvailableModels` body. It groups agent-callable models under
 * `agentModelSorts[].groups[].modelIds`, with tiered Flash ids under `tieredModelIds.flash`, and
 * describes each in `models[wireId]` (`maxTokens`). Source: opencodex
 * `parseAntigravityAvailableModels` (src/providers/antigravity-models.ts:489-560). Null when the
 * shape is unreadable or lists nothing, so the caller falls back instead of showing nothing.
 */
function readAnswer(payload: unknown): CatalogueAnswer | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const models = body.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const info = models as Record<string, unknown>;
  const listed: string[] = [];
  const add = (wireId: unknown): void => {
    if (listed.length >= ANSWER_MAX_IDS || typeof wireId !== "string" || !Object.hasOwn(info, wireId)) return;
    // A model outside the tables that the catalogue marks `disabled` is not offered: measured
    // 2026-11-13, a Pro account's CLI answer lists `gemini-4-carbon-disabled` with `disabled: true`
    // and "available to Ultra plan subscribers". A model in the tables is listed as before.
    if (!isStaticId(wireId) && (info[wireId] as { disabled?: unknown } | null)?.disabled === true) return;
    listed.push(wireId);
  };
  const sorts = Array.isArray(body.agentModelSorts) ? body.agentModelSorts : [];
  for (const sort of sorts) {
    const groups = sort && typeof sort === "object" ? (sort as { groups?: unknown }).groups : undefined;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const ids = group && typeof group === "object" ? (group as { modelIds?: unknown }).modelIds : undefined;
      if (Array.isArray(ids)) for (const id of ids) add(id);
    }
  }
  const tiered = body.tieredModelIds && typeof body.tieredModelIds === "object" ? (body.tieredModelIds as { flash?: unknown }).flash : undefined;
  if (Array.isArray(tiered)) for (const id of tiered) add(id);
  return listed.length > 0 ? { listed, info } : null;
}

/** The ids of an answer that the tables do not know, as `LearnedCatalogue.take` wants them. */
function outsideTables(answer: CatalogueAnswer): string[] {
  return [...new Set(answer.listed)].filter((id) => !isStaticId(id));
}

/** What the two answers of one host listed outside the tables. */
function clientsOf(ide: CatalogueAnswer, cli: CatalogueAnswer | null): { ide: string[]; cli?: string[] } {
  return { ide: outsideTables(ide), ...(cli ? { cli: outsideTables(cli) } : {}) };
}

/**
 * One host's rows, built once from both client families' answers: the IDE answer's ids, then what
 * only the CLI answer lists and the CLI family alone is served (the models named in
 * `servedToCliByName`, and what `fromCli` says: the provider's own `LearnedCatalogue.cliOnly`).
 * The second is how a model Google adds for the CLI family is listed without a change here, and
 * because the same lists choose the User-Agent, nothing is offered here that would then go out
 * under the wrong one. Everything else that only the CLI answer lists is left out as before: a
 * table model, a non-Gemini id, an id the lists do not keep, and an id that another host's IDE
 * answer lists (it is offered there, under the IDE User-Agent). `family` is the provider's own
 * rule (`LearnedCatalogue.family`), so a row is collapsed exactly when routing resolves it by
 * tier.
 *
 * Each wire id is collapsed to its base id first, then the context window and display name are taken
 * from the first wire id that carried that base. The wire ids are kept so per-model host routing can
 * match an exact wire id as well as a base id.
 */
function catalogueFrom(ide: CatalogueAnswer, cli: CatalogueAnswer | null, family: (base: string) => string[] | undefined, fromCli: (id: string) => boolean, limit: number): ParsedHostCatalogue | null {
  const ideListed = new Set(ide.listed);
  const added = cli ? cli.listed.filter((id) => !ideListed.has(id) && (servedToCliByName(id) || fromCli(id))) : [];
  const wireIds = [...ide.listed, ...added];
  const collapsed = new Map<string, string>();
  for (const wireId of wireIds) {
    const tableId = collapseWireId(wireId);
    const match = tableId === wireId ? TIER_SUFFIX.exec(wireId) : null;
    const id = match && family(match[1]!)?.includes(match[2]!) ? match[1]! : tableId;
    if (!collapsed.has(id)) collapsed.set(id, wireId);
  }
  const out: ProviderModel[] = [];
  const families: Record<string, string[]> = {};
  for (const [id, wireId] of collapsed) {
    const entry = Object.hasOwn(ide.info, wireId) ? ide.info[wireId] : cli?.info[wireId];
    const info = entry && typeof entry === "object" ? (entry as { maxTokens?: unknown; displayName?: unknown }) : undefined;
    // A collapsed row stands for every tier, so the tier its first wire id was named for is dropped:
    // "Gemini 4 Hydrogen (High)" would otherwise title the whole ladder, and a worker, "(High)".
    const displayName = typeof info?.displayName === "string" ? (id === wireId ? info.displayName : info.displayName.replace(/\s*\((?:Low|Medium|High|XHigh|Max|Minimal)\)\s*$/i, "")) : "";
    const contextWindow = typeof info?.maxTokens === "number" && Number.isFinite(info.maxTokens) && info.maxTokens > 0 ? Math.floor(info.maxTokens) : own(CONTEXT_WINDOWS, id);
    // A learned family's ladder is the tiers its ids name; `minimal` is a wire tier, not a picker effort.
    const tiers = id === wireId || isStaticId(id) ? undefined : family(id);
    if (tiers) families[id] = tiers;
    const efforts = own(EFFORT_LEVELS, id) ?? (tiers ?? []).filter((t) => PICKER_EFFORTS.includes(t));
    out.push({
      id,
      ...(displayName ? { name: displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(efforts.length ? { effortLevels: [...efforts] } : {}),
    });
    if (out.length >= limit) break;
  }
  if (out.length === 0) return null;
  return { models: out, wireIds, ...(Object.keys(families).length ? { families } : {}), clients: clientsOf(ide, cli) };
}

/**
 * Parse one `fetchAvailableModels` body on its own: the rows, the wire ids, and the tier families
 * its ids alone show. Returns null when the shape is unreadable.
 */
export function parseHostCatalogue(payload: unknown, limit = 200): ParsedHostCatalogue | null {
  const answer = readAnswer(payload);
  if (!answer) return null;
  const alone = new LearnedCatalogue();
  alone.take(new Map([["https://catalogue.invalid", clientsOf(answer, null)]]));
  return catalogueFrom(answer, null, (base) => alone.family(base), (id) => alone.cliOnly(id), limit);
}

/** The picker rows of one host's body, or null when the shape is unreadable. */
export function parseAvailableModels(payload: unknown, limit = 200): ProviderModel[] | null {
  return parseHostCatalogue(payload, limit)?.models ?? null;
}

/**
 * Which hosts offer each model id. A model's own id or any of its collapsed wire ids may name it,
 * because a host's catalogue lists wire ids (`gemini-3.8-flash-high`) while routing resolves a base
 * id (`gemini-3.8-flash`). Daily comes first in the list, so it is the preferred host.
 */
export type HostMap = Map<string, string[]>;

/** Build the per-model host map from each host's catalogue; a host with no catalogue contributes nothing. */
export function buildHostMap(cataloguesByHost: ReadonlyMap<string, ParsedHostCatalogue>): HostMap {
  const map: HostMap = new Map();
  for (const [host, catalogue] of cataloguesByHost) {
    const names = new Set<string>([...catalogue.models.map((m) => m.id), ...catalogue.wireIds]);
    for (const name of names) {
      const hosts = map.get(name) ?? [];
      if (!hosts.includes(host)) hosts.push(host);
      map.set(name, hosts);
    }
  }
  return map;
}

// ── Project discovery ───────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  }
  return undefined;
}

function signalFor(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(GOOGLE_OAUTH.requestTimeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Discover the account's Cloud Code Assist project: `loadCodeAssist` on the prod host, then
 * `onboardUser` polling on the daily host when the account has none yet. Returns undefined when
 * neither yields one. Source: opencodex `loadCodeAssistProject` / `onboardProject`.
 */
export async function discoverProject(accessToken: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | undefined> {
  const loaded = await loadCodeAssistProject(accessToken, fetchImpl, signal);
  if (loaded) return loaded;
  return onboardProject(accessToken, fetchImpl, signal, sleep);
}

async function loadCodeAssistProject(accessToken: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${GOOGLE_OAUTH.prodApi}/${GOOGLE_OAUTH.apiVersion}:loadCodeAssist`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: signalFor(signal),
    });
    if (!response.ok) return undefined;
    return extractProjectId((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
}

const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;

async function onboardProject(accessToken: string, fetchImpl: FetchLike, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) return undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${GOOGLE_OAUTH.dailyApi}/${GOOGLE_OAUTH.apiVersion}:onboardUser`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
        body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: ANTIGRAVITY_IDE_VERSION } }),
        signal: signalFor(signal),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) {
      // A transient refusal (429/5xx) is worth polling through; a hard 4xx will not change.
      if (response.status === 429 || response.status >= 500) {
        await sleep(ONBOARD_POLL_MS);
        continue;
      }
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.done === true) return extractProjectId(data.response as Record<string, unknown> | undefined);
    await sleep(ONBOARD_POLL_MS);
  }
  return undefined;
}

/** The account email from Google's pinned userinfo endpoint. Never persisted as a token. */
export async function fetchUserEmail(accessToken: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchImpl(GOOGLE_OAUTH.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: signalFor(signal),
    });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" && body.email.length > 0 ? body.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** `failed` hears why a null came back: the status, or the error's name or code, never a body or message. */
async function fetchAnswerAs(userAgent: string, accessToken: string, projectId: string, host: string, fetchImpl: FetchLike, signal?: AbortSignal, failed?: (reason: string) => void): Promise<CatalogueAnswer | null> {
  try {
    const response = await fetchImpl(`${host}/${GOOGLE_OAUTH.apiVersion}:fetchAvailableModels`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({ project: projectId }),
      signal: signalFor(signal),
    });
    if (!response.ok) {
      failed?.(`HTTP ${response.status}`);
      return null;
    }
    const answer = readAnswer(await response.json().catch(() => undefined));
    if (!answer) failed?.("unreadable answer");
    return answer;
  } catch (error) {
    failed?.(signal?.aborted ? "cut off" : ((error as NodeJS.ErrnoException).code ?? (error as Error).name ?? "error"));
    return null;
  }
}

/** How long the CLI ask may still run once the IDE answer is in. Both normally answer together. */
export const CLI_CATALOGUE_GRACE_MS = 3_000;

/**
 * Both client families' answers of one host, or null when the IDE one cannot be read. Never throws.
 * Each model is listed from the answer to the User-Agent it will be called with: the IDE answer gives
 * every model as before, and a second ask under the CLI UA adds the models served to the CLI family
 * alone (`catalogueFrom`). An unreadable IDE answer is null as before, so a CLI-only list never
 * replaces the static fallback. The CLI ask is optional, so a stalled one is cut off `cliGraceMs`
 * after the IDE answer instead of holding the first turn after a restart for the full request
 * timeout. Because the IDE catalogue still answers, a failed CLI ask is otherwise silent while Argon
 * drops out of the list: `cliFailed` hears it, once the IDE answer is in.
 */
async function readHost(accessToken: string, projectId: string, host: string, fetchImpl: FetchLike, signal: AbortSignal | undefined, cliGraceMs: number, cliFailed?: (reason: string) => void): Promise<{ ide: CatalogueAnswer; cli: CatalogueAnswer | null } | null> {
  const cliAbort = new AbortController();
  const cliSignal = signal ? AbortSignal.any([signal, cliAbort.signal]) : cliAbort.signal;
  let cliFailure: string | undefined;
  const pendingCli = fetchAnswerAs(antigravityCliUserAgent(), accessToken, projectId, host, fetchImpl, cliSignal, (reason) => { cliFailure = reason; });
  const ide = await fetchAnswerAs(antigravityUserAgent(), accessToken, projectId, host, fetchImpl, signal);
  if (!ide) {
    cliAbort.abort();
    return null;
  }
  const grace = setTimeout(() => cliAbort.abort(), cliGraceMs);
  const cli = await pendingCli;
  clearTimeout(grace);
  if (!cli && cliFailure && !signal?.aborted) cliFailed?.(cliFailure);
  return { ide, cli };
}

/**
 * One host's catalogue, or null when the endpoint cannot be read (`readHost`), with the tier
 * families this host's own answers show. A provider's listing goes through `fetchAvailableModels`,
 * which decides families over every host it reads.
 */
export async function fetchHostCatalogue(accessToken: string, projectId: string, host: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal, cliGraceMs = CLI_CATALOGUE_GRACE_MS, cliFailed?: (reason: string) => void): Promise<ParsedHostCatalogue | null> {
  const read = await readHost(accessToken, projectId, host, fetchImpl, signal, cliGraceMs, cliFailed);
  if (!read) return null;
  const alone = new LearnedCatalogue();
  alone.take(new Map([[host, clientsOf(read.ide, read.cli)]]));
  return catalogueFrom(read.ide, read.cli, (base) => alone.family(base), (id) => alone.cliOnly(id), 200);
}

/** The merged catalogue of every host that answered, and which hosts offer which model. */
export type MergedCatalogue = {
  models: ProviderModel[];
  /** Model id (or any collapsed wire id) → the hosts that offer it, preferred host first. */
  hosts: HostMap;
  /** The per-host catalogues that were readable. */
  byHost: Map<string, ParsedHostCatalogue>;
  /** Whether this read changed what `opts.learned` holds. */
  learnedChanged: boolean;
};

/**
 * The models a CCA account can reach, asked on every host that offers them (measured 2026-10-20:
 * the prod host lists Gemini Pro models the daily host does not, and vice versa for some Flash
 * tiers). Models are merged with the preferred host's row winning, and the returned host map is
 * what routing uses to send a model to a host that actually offers it. Null when no host answered.
 *
 * `opts.learned` is the provider's own `LearnedCatalogue`: the read is taken into it first, and the
 * rows are then collapsed by its rule, so the list offers a family exactly when routing resolves
 * one. Without it the read is judged on its own.
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  opts: { hosts?: readonly string[]; fetchImpl?: FetchLike; signal?: AbortSignal; cliFailed?: (host: string, reason: string) => void; learned?: LearnedCatalogue } = {},
): Promise<MergedCatalogue | null> {
  const hosts = opts.hosts ?? GOOGLE_OAUTH.hosts;
  const results = await Promise.all(hosts.map(async (host) => [host, await readHost(accessToken, projectId, host, opts.fetchImpl ?? fetch, opts.signal, CLI_CATALOGUE_GRACE_MS, opts.cliFailed && ((reason) => opts.cliFailed!(host, reason)))] as const));
  const reads = results.filter((r): r is readonly [string, { ide: CatalogueAnswer; cli: CatalogueAnswer | null }] => r[1] !== null);
  if (reads.length === 0) return null;
  const learned = opts.learned ?? new LearnedCatalogue();
  const learnedChanged = learned.take(new Map(reads.map(([host, read]) => [host, clientsOf(read.ide, read.cli)])));
  const byHost = new Map<string, ParsedHostCatalogue>();
  for (const [host, read] of reads) {
    const catalogue = catalogueFrom(read.ide, read.cli, (base) => learned.family(base), (id) => learned.cliOnly(id), 200);
    if (catalogue) byHost.set(host, catalogue);
  }
  if (byHost.size === 0) return null;
  return { ...mergeHostCatalogues(byHost), byHost, learnedChanged };
}

/**
 * One list and one host map from per-host catalogues. Map order is preference order (daily first),
 * so the first host to list a model keeps its row and a host that is absent contributes nothing.
 */
export function mergeHostCatalogues(byHost: ReadonlyMap<string, ParsedHostCatalogue>): { models: ProviderModel[]; hosts: HostMap } {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const catalogue of byHost.values()) {
    for (const model of catalogue.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
  }
  return { models, hosts: buildHostMap(byHost) };
}

/**
 * The host a model's request should go to: the first host in `hosts` that offers the resolved wire
 * id or the base id, else `fallback`. An unknown model is not hidden — it goes to the default only.
 */
export function hostForModel(hosts: ReadonlyMap<string, readonly string[]>, model: string, wire: string, fallback: string): string {
  return hosts.get(wire)?.[0] ?? hosts.get(model)?.[0] ?? fallback;
}
