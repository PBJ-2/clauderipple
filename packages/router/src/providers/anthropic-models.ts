// The Claude models the signed-in account can use, from Anthropic's own `GET /v1/models`.
//
// The list used to be a constant in admin.ts, so every release after it was cut was missing from
// the provider form and the mapping table until a ClaudeRipple release caught up: Opus 5.5 (Sep 21),
// Sonnet 5.5 (Sep 28) and Haiku 5.5 (Oct 7) all were (2026-10-08). The endpoint answers the Claude
// Code login as well as an API key, newest first, and each entry states its effort ladder and
// context window (measured 2026-10-08 with the observed login: 14 models, `claude-haiku-5-5` first).
import type { ProviderModel } from "../config.ts";
import { retryAfterMs as parseRetryAfterMs, type Credential } from "../pool.ts";

export type ClaudeModel = ProviderModel & {
  /** The family (`opus`, `sonnet`, `haiku`, `fable`, `mythos`), as the API names it. */
  line?: string;
  /** Release time, epoch ms. Newest first is how the API sorts them. */
  createdAt?: number;
};

/** `claude-haiku-4-5-20251001` as `claude-haiku-4-5`: the id the catalog and Claude Code's aliases use. */
export function undatedClaudeId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

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
      max_input_tokens?: unknown; max_tokens?: unknown; capabilities?: { effort?: Record<string, unknown> };
    };
    if (typeof m.id !== "string" || !m.id.startsWith("claude-")) continue;
    if (m.lifecycle !== undefined && m.lifecycle !== "active") continue;
    const id = undatedClaudeId(m.id);
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
    // `max_tokens`: "Maximum value for the `max_tokens` parameter when using this model" (List Models reference, 2026-11-28).
    if (typeof m.max_tokens === "number" && Number.isFinite(m.max_tokens) && m.max_tokens > 0) entry.maxOutputTokens = Math.floor(m.max_tokens);
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
  /** The first wait after a lookup that got no list; it doubles on each further miss, up to `ttlMs`. */
  retryMs?: number;
  timeoutMs?: number;
  /** How long list() waits for the first list before returning null. */
  waitMs?: number;
  warn?: (message: string) => void;
};

/**
 * The current Claude login's model list, fetched at most once per `ttlMs` (an hour by default:
 * Anthropic ships a model every few weeks). Another account is never asked because its list would be
 * applied to providers that do not use it. A failed lookup keeps the last good list, serves that cache
 * while refreshing, and honours Retry-After. With no cache, list() waits at most `waitMs` (two seconds
 * by default) while the fetch continues. A miss is tried again after `retryMs` (30 s by default,
 * doubling); this still recovers the case observed on 2026-11-18 because the current slot becomes the
 * login Claude Code sends once it sends one. `onFirstList` notifies callers when the first list arrives.
 */
export class ClaudeModelCatalog {
  private last: ClaudeModel[] | null = null;
  private nextAt = Number.NEGATIVE_INFINITY;
  private misses = 0;
  private inFlight: Promise<ClaudeModel[] | null> | null = null;
  private readonly firstListListeners = new Set<() => void>();
  private readonly source: CatalogSource;
  private readonly opts: CatalogOptions;

  constructor(source: CatalogSource, opts: CatalogOptions) {
    this.source = source;
    this.opts = opts;
  }

  list(): Promise<ClaudeModel[] | null> {
    if ((this.opts.now ?? Date.now)() < this.nextAt) return Promise.resolve(this.last);
    this.inFlight ??= this.refresh();
    if (this.last !== null) return Promise.resolve(this.last);
    const inFlight = this.inFlight;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<ClaudeModel[] | null>((resolve) => {
      timer = setTimeout(() => resolve(this.last), this.opts.waitMs ?? 2_000);
      timer.unref();
    });
    return Promise.race([inFlight, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * The last list had, and nothing else: no lookup is started and nothing is waited for. A request
   * path reads this because a refresh can reach the Keychain (a synchronous read of up to 5 s on macOS).
   * The list is kept fresh by the callers of list().
   */
  peek(): ClaudeModel[] | null {
    return this.last;
  }

  /** Call `listener` once, right after the first lookup that gets a list; never once a list is had. */
  onFirstList(listener: () => void): void {
    if (this.last === null) this.firstListListeners.add(listener);
  }

  private async refresh(): Promise<ClaudeModel[] | null> {
    try {
      const result = await this.fetch();
      const ttl = this.opts.ttlMs ?? 60 * 60_000;
      let wait: number;
      if (result.got) {
        this.misses = 0;
        wait = ttl;
      } else {
        wait = Math.max(Math.min(ttl, (this.opts.retryMs ?? 30_000) * 2 ** this.misses), result.retryAfterMs ?? 0);
        this.misses++;
      }
      this.nextAt = (this.opts.now ?? Date.now)() + wait;
      return this.last;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetch(): Promise<{ got: boolean; retryAfterMs?: number }> {
    let credential: Credential | undefined;
    try {
      credential = (await this.source.credentials())[0];
    } catch (e) {
      this.opts.warn?.(`claude models: no credentials: ${(e as Error).message}`);
      return { got: false };
    }
    if (!credential) return { got: false };
    try {
      const models = await fetchClaudeModels(`https://${this.opts.upstream()}`, credential.headers, this.opts.fetch, this.opts.timeoutMs);
      if (!models.length) return { got: false };
      const first = this.last === null;
      this.last = models;
      if (first) {
        const listeners = [...this.firstListListeners];
        this.firstListListeners.clear();
        for (const listener of listeners) {
          try { listener(); }
          catch (e) { this.opts.warn?.(`claude models: onFirstList listener: ${(e as Error).message}`); }
        }
      }
      return { got: true };
    } catch (e) {
      this.opts.warn?.(`claude models: ${(e as Error).message}`);
      return { got: false, ...(e instanceof ClaudeModelsHttpError && e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
    }
  }
}

export class ClaudeModelsHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs: number | undefined) {
    super(`HTTP ${status}`);
    this.name = "ClaudeModelsHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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
  if (!res.ok) throw new ClaudeModelsHttpError(res.status, parseRetryAfterMs({ "retry-after": res.headers.get("retry-after") ?? undefined }));
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
    const model = byId.get(undatedClaudeId(id));
    if (!model?.line || model.createdAt === undefined) continue;
    newest.set(model.line, Math.max(newest.get(model.line) ?? Number.NEGATIVE_INFINITY, model.createdAt));
  }
  const declaredIds = new Set(declared.map(undatedClaudeId));
  return live.filter((model) => {
    if (declaredIds.has(model.id) || offered.has(model.id) || !model.line || model.createdAt === undefined) return false;
    const floor = newest.get(model.line);
    return floor !== undefined && model.createdAt > floor;
  });
}
