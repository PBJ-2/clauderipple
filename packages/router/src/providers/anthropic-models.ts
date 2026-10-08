// The Claude models the signed-in account can use, from Anthropic's own `GET /v1/models`.
//
// The list used to be a constant in admin.ts, so every release after it was cut was missing from
// the provider form and the mapping table until a ClaudeRipple release caught up: Opus 5.5 (Sep 21),
// Sonnet 5.5 (Sep 28) and Haiku 5.5 (Oct 7) all were (2026-10-08). The endpoint answers the Claude
// Code login as well as an API key, newest first, and each entry states its effort ladder and
// context window (measured 2026-10-08 with the observed login: 14 models, `claude-haiku-5-5` first).
import type { ProviderModel } from "../config.ts";
import type { Credential } from "../pool.ts";

export type ClaudeModel = ProviderModel & {
  /** The family (`opus`, `sonnet`, `haiku`, `fable`), as the API names it. */
  line?: string;
  /** Release time, epoch ms. Newest first is how the API sorts them. */
  createdAt?: number;
};

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

/**
 * The active models in a `/v1/models` body. A dated id (`claude-haiku-4-5-20251001`) is folded to
 * its alias, which the API takes as well and which is the id the rest of ClaudeRipple and Claude
 * Code's own aliases use.
 */
export function claudeModelsFromBody(body: unknown): ClaudeModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ClaudeModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as {
      id?: unknown; display_name?: unknown; created_at?: unknown; line?: unknown; lifecycle?: unknown;
      max_input_tokens?: unknown; capabilities?: { effort?: Record<string, unknown> };
    };
    if (typeof m.id !== "string" || !m.id.startsWith("claude-")) continue;
    if (m.lifecycle !== undefined && m.lifecycle !== "active") continue;
    const id = m.id.replace(/-\d{8}$/, "");
    if (out.some((entry) => entry.id === id)) continue;
    const name = typeof m.display_name === "string" ? m.display_name.replace(/^Claude\s+/, "") : id;
    const effort = m.capabilities?.effort;
    const supported = (key: string): boolean => {
      const value = effort?.[key];
      return typeof value === "object" && value !== null && (value as { supported?: unknown }).supported === true;
    };
    const entry: ClaudeModel = { id, name };
    // Haiku 4.5 reports the effort block with every level unsupported: it takes no effort at all.
    if (effort && typeof effort === "object") entry.effortLevels = (effort as { supported?: unknown }).supported === true ? EFFORT_ORDER.filter(supported) : [];
    if (typeof m.max_input_tokens === "number" && m.max_input_tokens > 0) entry.contextWindow = m.max_input_tokens;
    if (typeof m.line === "string") entry.line = m.line;
    const created = typeof m.created_at === "string" ? Date.parse(m.created_at) : NaN;
    if (Number.isFinite(created)) entry.createdAt = created;
    out.push(entry);
  }
  return out;
}

type CatalogSource = { credentials(): Promise<Credential[]> };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type CatalogOptions = {
  /** The Anthropic API host (`config.upstream`). */
  upstream: () => string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

/**
 * The account's model list, fetched at most once per `ttlMs` (an hour by default: Anthropic ships a
 * model every few weeks). A failed lookup keeps the last good list, and null means none was ever
 * had, so a caller falls back to its own.
 */
export class ClaudeModelCatalog {
  private last: ClaudeModel[] | null = null;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<ClaudeModel[] | null> | null = null;
  private readonly source: CatalogSource;
  private readonly opts: CatalogOptions;

  constructor(source: CatalogSource, opts: CatalogOptions) {
    this.source = source;
    this.opts = opts;
  }

  list(): Promise<ClaudeModel[] | null> {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.fetchedAt < (this.opts.ttlMs ?? 60 * 60_000)) return Promise.resolve(this.last);
    this.inFlight ??= this.fetch().finally(() => {
      this.fetchedAt = (this.opts.now ?? Date.now)();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<ClaudeModel[] | null> {
    let credential: Credential | undefined;
    try {
      credential = (await this.source.credentials())[0];
    } catch (e) {
      this.opts.warn?.(`claude models: no credentials: ${(e as Error).message}`);
      return this.last;
    }
    if (!credential) return this.last;
    try {
      const models = await fetchClaudeModels(`https://${this.opts.upstream()}`, credential.headers, this.opts.fetch, this.opts.timeoutMs);
      if (models.length) this.last = models;
    } catch (e) {
      this.opts.warn?.(`claude models: ${(e as Error).message}`);
    }
    return this.last;
  }
}

/** One `GET /v1/models` with the given credentials. Throws on anything but a usable answer. */
export async function fetchClaudeModels(origin: string, headers: Record<string, string>, fetchImpl: FetchLike = fetch, timeoutMs = 8000): Promise<ClaudeModel[]> {
  const res = await fetchImpl(`${origin}/v1/models?limit=100`, {
    method: "GET",
    headers: { "anthropic-version": "2023-06-01", ...headers, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // The status alone: the body of an auth failure is not worth the risk of echoing.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return claudeModelsFromBody(await res.json());
}

/**
 * The models to add to a provider's declared list: each one released after the newest model it
 * already declares in the same family, and not offered before. A family the provider does not
 * declare at all is left out — someone who unticked every Sonnet did not ask for the next one — and
 * so is anything in `offered`, so a model unticked after it arrived does not come back.
 */
export function newClaudeReleases(live: ClaudeModel[], declared: string[], offered: ReadonlySet<string>): ClaudeModel[] {
  const byId = new Map(live.map((model) => [model.id, model]));
  const newest = new Map<string, number>();
  for (const id of declared) {
    const model = byId.get(id.replace(/-\d{8}$/, ""));
    if (!model?.line || model.createdAt === undefined) continue;
    newest.set(model.line, Math.max(newest.get(model.line) ?? Number.NEGATIVE_INFINITY, model.createdAt));
  }
  const declaredIds = new Set(declared.map((id) => id.replace(/-\d{8}$/, "")));
  return live.filter((model) => {
    if (declaredIds.has(model.id) || offered.has(model.id) || !model.line || model.createdAt === undefined) return false;
    const floor = newest.get(model.line);
    return floor !== undefined && model.createdAt > floor;
  });
}
