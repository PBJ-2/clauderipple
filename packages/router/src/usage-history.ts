import fs from "node:fs";
import path from "node:path";
import type { RequestRecord } from "./requestlog.ts";
import { chargeOf, priceOf } from "./prices.ts";

const HOUR_MS = 3_600_000;

export type SummaryBucket = {
  count: number;
  ok: number;
  failed: number;
  input: number;
  cached: number;
  /** Tokens written to the prompt cache: part of the input, and not a hit. */
  cacheWrite: number;
  output: number;
  cacheHitPercent: number;
  avgMs: number;
  /** What these requests cost at API-price equivalents (see prices.ts), in USD, full precision. */
  costUsd: number;
  /** Requests that had tokens but no price (the model is in neither the Claude table nor the AA dataset). */
  unpricedRequests: number;
  /** Requests priced from an estimate (see `priceOf`), not from an official figure. */
  estimatedRequests: number;
};

export type ModelUsageBucket = SummaryBucket & { provider: string; model: string; purpose?: "web-search" };

/** The part of a bucket that is summed across records and hours; `ms` is the sum of durations. */
export type BucketTotals = {
  count: number;
  ok: number;
  failed: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  ms: number;
  /** USD at API-price equivalents. */
  cost: number;
  unpriced: number;
  estimated: number;
};

export type ConversationTokens = {
  /** Last prompt per conversation + all outputs in this period. */
  conversationTokens: number;
  /** Records without a conversation key, counted independently (includes legacy history). */
  ungroupedRequests: number;
};

type ConversationTurn = { at: number; prompt: number; output: number };
// Persist one state per (hour, provider, model, conversation), not one per request. No eviction:
// dropping old identities would silently overcount later summaries. A query's temporary state is
// O(distinct conversations in its range); retained history is O(distinct hourly conversation states).
type ConversationTotals = {
  turns: Record<string, ConversationTurn>;
  ungroupedTokens: number;
  ungroupedRequests: number;
};

export type UsageSummary = {
  total: SummaryBucket & ConversationTokens;
  providers: Record<string, SummaryBucket & ConversationTokens>;
  models: ModelUsageBucket[];
  earliest: string | null;
};

/**
 * One persisted line: a partial bucket for (hour, provider, model). Lines are additive.
 * `purpose` splits a model's web searches out of its own turns; lines from before it existed keep
 * the old shape (see `modelRowOf`).
 * A line from before costs existed has no `cost`: it is kept in memory as `legacy` and priced when a summary is read.
 */
type HourBucket = BucketTotals & { h: number; p: string; m: string; purpose?: "web-search"; conversations?: ConversationTotals; legacy?: true };

/** What the dashboard's model table reads a record as. */
export type ModelRow = { model: string; purpose?: "web-search" };

function accounted(usage: { input: number; cached: number; cacheWrite?: number; output: number } | undefined): boolean {
  return usage !== undefined && usage.input + usage.cached + (usage.cacheWrite ?? 0) + usage.output > 0;
}

/**
 * The row a request belongs to on the model table.
 *
 * A `WebSearch` side request is not a turn of the model: it is counted as its own row, named by the
 * model id the router actually searched with. Before 2026-10-26 the search path left that id as
 * `"<provider>/<model>"` in `target` and recorded no tokens at all, so the same rule recognises both
 * shapes: a record with the flag, and one whose target is exactly its provider's name, a slash, and
 * the rest — with nothing accounted. A real routed turn nearly always reports tokens, and a
 * vendor-namespaced model id (`zai-org/glm-5.3-flash`) only looks like this when the provider is
 * named after its own vendor and it read no tokens at all. The dashboard must not split such a row.
 */
export function modelRowOf(record: {
  provider: string;
  target: string;
  purpose?: RequestRecord["purpose"];
  usage?: { input: number; cached: number; cacheWrite?: number; output: number };
}): ModelRow {
  const prefix = `${record.provider}/`;
  const rest = record.target.startsWith(prefix) && record.target.length > prefix.length ? record.target.slice(prefix.length) : null;
  if (record.purpose === "web-search") return { model: rest ?? record.target, purpose: "web-search" };
  if (rest !== null && !accounted(record.usage)) return { model: rest, purpose: "web-search" };
  return { model: record.target };
}

export function emptyConversations(): ConversationTotals {
  return { turns: Object.create(null) as Record<string, ConversationTurn>, ungroupedTokens: 0, ungroupedRequests: 0 };
}

export function recordConversations(record: RequestRecord): ConversationTotals {
  const totals = emptyConversations();
  if (!record.usage) return totals;
  const prompt = record.usage.input + record.usage.cached + (record.usage.cacheWrite ?? 0);
  if (record.conversation && record.kind === "messages" && !record.purpose) {
    totals.turns[record.conversation] = { at: Date.parse(record.at), prompt, output: record.usage.output };
  } else {
    totals.ungroupedTokens = prompt + record.usage.output;
    totals.ungroupedRequests = 1;
  }
  return totals;
}

export function addConversations(target: ConversationTotals, source: ConversationTotals): void {
  target.ungroupedTokens += source.ungroupedTokens;
  target.ungroupedRequests += source.ungroupedRequests;
  for (const [key, turn] of Object.entries(source.turns)) {
    const previous = target.turns[key];
    target.turns[key] = previous
      ? { ...(turn.at >= previous.at ? turn : previous), output: previous.output + turn.output }
      : { ...turn };
  }
}

export function finishConversations(totals: ConversationTotals): ConversationTokens {
  let tokens = totals.ungroupedTokens;
  for (const turn of Object.values(totals.turns)) tokens += turn.prompt + turn.output;
  return { conversationTokens: tokens, ungroupedRequests: totals.ungroupedRequests };
}

/** Old hourly records cannot recover conversation identity: expose the independent-request fallback. */
function conversationsOf(bucket: HourBucket): ConversationTotals {
  return bucket.conversations ?? {
    ...emptyConversations(),
    ungroupedTokens: bucket.input + bucket.cached + bucket.cacheWrite + bucket.output,
    ungroupedRequests: bucket.count,
  };
}

export function emptyTotals(): BucketTotals {
  return { count: 0, ok: 0, failed: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, ms: 0, cost: 0, unpriced: 0, estimated: 0 };
}

type Priced = Pick<BucketTotals, "cost" | "unpriced" | "estimated">;
const NOTHING: Priced = { cost: 0, unpriced: 0, estimated: 0 };

/**
 * One record's cost. A count_tokens call and a record without tokens cost nothing and are not
 * unpriced. An image is billed per image, not per token, so it costs nothing here and is neither
 * unpriced nor estimated. Any other record with tokens is priced by its model, and is unpriced when
 * no price is known; it is estimated when a component it used is not official.
 */
function recordCost(record: RequestRecord): Priced {
  const usage = record.usage;
  if (!usage || record.kind === "count_tokens" || record.kind === "image" || !accounted(usage)) return NOTHING;
  const cacheWrite = usage.cacheWrite ?? 0;
  const price = priceOf(record.provider, modelRowOf(record).model, usage.input + usage.cached + cacheWrite, record.servedTier);
  if (!price) return { cost: 0, unpriced: 1, estimated: 0 };
  const charge = chargeOf(price, { input: usage.input, cached: usage.cached, cacheWrite, output: usage.output });
  return { cost: charge.usd, unpriced: 0, estimated: charge.estimated ? 1 : 0 };
}

/**
 * A legacy hour's cost, priced now from its token totals at the base tier. The hour does not keep
 * per-request prompt sizes, so the tier is a guess, and every request in it counts as estimated (or as
 * unpriced, when the model has no price). An image hour (target `image`) costs nothing, as in recordCost.
 */
function legacyCost(bucket: HourBucket): Priced {
  if (bucket.m === "image" || !accounted(bucket)) return NOTHING;
  const price = priceOf(bucket.p, bucket.m, 0);
  if (!price) return { cost: 0, unpriced: bucket.count, estimated: 0 };
  const charge = chargeOf(price, { input: bucket.input, cached: bucket.cached, cacheWrite: bucket.cacheWrite, output: bucket.output });
  return { cost: charge.usd, unpriced: 0, estimated: bucket.count };
}

/** The totals a bucket contributes to a summary: a legacy line is priced here, a stored one is read as stored. */
function totalsOf(bucket: HourBucket): BucketTotals {
  return bucket.legacy ? { ...bucket, ...legacyCost(bucket) } : bucket;
}

/** The same counting rules as `RequestLog.summary`, for one record. */
export function recordTotals(record: RequestRecord): BucketTotals {
  const totals = emptyTotals();
  totals.count = 1;
  if (record.ok) totals.ok = 1;
  else if (!record.resent) totals.failed = 1;
  totals.ms = record.ms;
  if (record.usage) {
    totals.input = record.usage.input;
    totals.cached = record.usage.cached;
    totals.cacheWrite = record.usage.cacheWrite ?? 0;
    totals.output = record.usage.output;
  }
  Object.assign(totals, recordCost(record));
  return totals;
}

export function addTotals(target: BucketTotals, source: BucketTotals): void {
  target.count += source.count;
  target.ok += source.ok;
  target.failed += source.failed;
  target.input += source.input;
  target.cached += source.cached;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.ms += source.ms;
  target.cost += source.cost;
  target.unpriced += source.unpriced;
  target.estimated += source.estimated;
}

/** Derives the rate columns from summed totals. A cache write is input the model read fresh, so it
 * counts against the hit rate (leaving it out read a turn that wrote 2,218 tokens and uncached 2 as
 * a 100% hit, 2026-09-23). */
export function finishTotals(totals: BucketTotals): SummaryBucket {
  const base = totals.input + totals.cached + totals.cacheWrite;
  return {
    count: totals.count,
    ok: totals.ok,
    failed: totals.failed,
    input: totals.input,
    cached: totals.cached,
    cacheWrite: totals.cacheWrite,
    output: totals.output,
    cacheHitPercent: base > 0 ? Math.round((totals.cached / base) * 1000) / 10 : 0,
    avgMs: totals.count > 0 ? Math.round(totals.ms / totals.count) : 0,
    costUsd: totals.cost,
    unpricedRequests: totals.unpriced,
    estimatedRequests: totals.estimated,
  };
}

function bucketKey(h: number, provider: string, model: string, purpose?: "web-search"): string {
  return `${h}\u0000${provider}\u0000${purpose ?? ""}\u0000${model}`;
}

function modelKey(provider: string, model: string, purpose?: "web-search"): string {
  return `${provider}\u0000${purpose ?? ""}\u0000${model}`;
}

/** Models with the most tokens read first (input + cached + cacheWrite), then the busiest. */
export function sortByVolume<T extends SummaryBucket & { provider: string; model: string }>(models: T[]): void {
  const volume = (bucket: SummaryBucket): number => bucket.input + bucket.cached + bucket.cacheWrite;
  models.sort((a, b) => volume(b) - volume(a) || b.count - a.count);
}

function isConversationTotals(value: unknown): value is ConversationTotals {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<ConversationTotals>;
  if (typeof c.ungroupedTokens !== "number" || !Number.isFinite(c.ungroupedTokens) ||
      typeof c.ungroupedRequests !== "number" || !Number.isFinite(c.ungroupedRequests) ||
      !c.turns || typeof c.turns !== "object" || Array.isArray(c.turns)) return false;
  return Object.entries(c.turns).every(([key, turn]) => /^[a-f0-9]{32}$/.test(key) &&
    turn && typeof turn === "object" &&
    [turn.at, turn.prompt, turn.output].every((n) => typeof n === "number" && Number.isFinite(n)));
}

function isHourBucket(value: unknown): value is HourBucket {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<HourBucket>;
  return typeof b.h === "number" && Number.isFinite(b.h) && Number.isInteger(b.h) &&
    typeof b.p === "string" && typeof b.m === "string" &&
    (b.purpose === undefined || b.purpose === "web-search") &&
    (b.conversations === undefined || isConversationTotals(b.conversations)) &&
    ["count", "ok", "failed", "input", "cached", "cacheWrite", "output", "ms"].every((key) => {
      const n = (b as unknown as Record<string, unknown>)[key];
      return typeof n === "number" && Number.isFinite(n);
    }) &&
    // Cost fields are absent on a line from before prices existed; when present they must be numbers.
    ["cost", "unpriced", "estimated"].every((key) => {
      const n = (b as unknown as Record<string, unknown>)[key];
      return n === undefined || (typeof n === "number" && Number.isFinite(n));
    });
}

function toLine(bucket: HourBucket): string {
  return JSON.stringify({
    h: bucket.h,
    p: bucket.p,
    m: bucket.m,
    ...(bucket.purpose ? { purpose: bucket.purpose } : {}),
    count: bucket.count,
    ok: bucket.ok,
    failed: bucket.failed,
    input: bucket.input,
    cached: bucket.cached,
    cacheWrite: bucket.cacheWrite,
    output: bucket.output,
    ms: bucket.ms,
    cost: bucket.cost,
    unpriced: bucket.unpriced,
    estimated: bucket.estimated,
    conversations: bucket.conversations,
  }) + "\n";
}

/**
 * Durable hourly usage history, appended to `usage-hourly.jsonl` next to `requests.jsonl`.
 *
 * Invariant: every hour below the open hour is fully on disk (possibly as several additive lines
 * for the same (h,p,m)); only the open hour lives in memory. A late record (its hour is below the
 * open hour because a request started earlier and finished later) is appended immediately as its
 * own line. On startup the file's highest hour is the watermark, and request records above it are
 * replayed, so an hour never counted twice yet the open hour survives a restart.
 */
export class UsageHistory {
  private readonly file: string;
  private readonly buckets = new Map<string, HourBucket>();
  private readonly open = new Map<string, HourBucket>();
  private openHour: number | null = null;
  private highestHour: number | null = null;
  private earliestHour: number | null = null;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  /** Highest hour already on disk, or null when nothing was persisted yet. */
  get watermark(): number | null {
    return this.highestHour;
  }

  /** Feeds startup replay: records at or below the watermark are already on disk. */
  replay(records: RequestRecord[]): void {
    const floor = this.highestHour;
    for (const record of records) {
      const hour = hourOf(record);
      if (hour === null) continue;
      if (floor !== null && hour <= floor) continue;
      this.add(record);
    }
  }

  add(record: RequestRecord): void {
    const hour = hourOf(record);
    if (hour === null) return;
    this.observe(hour);
    // The bucket carries the normalized row, so a web search is written with its own model id and
    // flag rather than the old "<provider>/<model>" shape.
    const row = modelRowOf(record);
    const bucket: HourBucket = {
      h: hour, p: record.provider, m: row.model, ...(row.purpose ? { purpose: row.purpose } : {}),
      ...recordTotals(record), conversations: recordConversations(record),
    };
    if (this.openHour !== null && hour < this.openHour) {
      this.append([bucket]);
      this.merge(this.buckets, bucket);
      return;
    }
    if (this.openHour === null || hour > this.openHour) {
      this.flush();
      this.openHour = hour;
    }
    this.merge(this.open, bucket);
  }

  /** Buckets whose hour start lies in [fromMs, toMs), summed across providers and models. */
  summary(fromMs: number, toMs: number): UsageSummary {
    const fromHour = Math.floor(fromMs / HOUR_MS);
    const conversations = emptyConversations();
    const providerConversations = new Map<string, ConversationTotals>();
    const total = emptyTotals();
    const providers = new Map<string, BucketTotals>();
    const models = new Map<string, { totals: BucketTotals; provider: string; model: string; purpose?: "web-search" }>();
    for (const bucket of [...this.buckets.values(), ...this.open.values()]) {
      if (bucket.h < fromHour || bucket.h * HOUR_MS >= toMs) continue;
      const totals = totalsOf(bucket);
      addTotals(total, totals);
      const accounting = conversationsOf(bucket);
      addConversations(conversations, accounting);
      const perProvider = providerConversations.get(bucket.p) ?? emptyConversations();
      addConversations(perProvider, accounting);
      providerConversations.set(bucket.p, perProvider);
      const provider = providers.get(bucket.p) ?? providers.set(bucket.p, emptyTotals()).get(bucket.p)!;
      addTotals(provider, totals);
      const row = modelRowOf({
        provider: bucket.p, target: bucket.m, ...(bucket.purpose ? { purpose: bucket.purpose } : {}),
        usage: { input: bucket.input, cached: bucket.cached, cacheWrite: bucket.cacheWrite, output: bucket.output },
      });
      const key = modelKey(bucket.p, row.model, row.purpose);
      const model = models.get(key) ?? (models.set(key, { totals: emptyTotals(), provider: bucket.p, model: row.model, ...(row.purpose ? { purpose: row.purpose } : {}) }).get(key)!);
      addTotals(model.totals, totals);
    }
    const modelList = [...models.values()].map(({ totals, provider, model, purpose }) => ({ ...finishTotals(totals), provider, model, ...(purpose ? { purpose } : {}) }));
    sortByVolume(modelList);
    return {
      total: { ...finishTotals(total), ...finishConversations(conversations) },
      providers: Object.fromEntries([...providers].map(([name, totals]) => [name, { ...finishTotals(totals), ...finishConversations(providerConversations.get(name)!) }])),
      models: modelList,
      earliest: this.earliestHour === null ? null : new Date(this.earliestHour * HOUR_MS).toISOString(),
    };
  }

  private observe(hour: number): void {
    if (this.earliestHour === null || hour < this.earliestHour) this.earliestHour = hour;
  }

  private merge(target: Map<string, HourBucket>, bucket: HourBucket): void {
    // A legacy line is kept apart from a priced one for the same hour: only the former is priced at read time.
    const key = bucketKey(bucket.h, bucket.p, bucket.m, bucket.purpose) + (bucket.legacy ? "\u0001legacy" : "");
    const existing = target.get(key);
    if (existing) {
      const conversations = conversationsOf(existing);
      addConversations(conversations, conversationsOf(bucket));
      existing.conversations = conversations;
      addTotals(existing, bucket);
    } else target.set(key, { ...bucket });
    if (target === this.buckets && (this.highestHour === null || bucket.h > this.highestHour)) this.highestHour = bucket.h;
  }

  private flush(): void {
    if (this.open.size === 0) return;
    const lines = [...this.open.values()];
    this.open.clear();
    this.append(lines);
    for (const line of lines) this.merge(this.buckets, line);
  }

  private append(lines: HourBucket[]): void {
    if (lines.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, lines.map(toLine).join(""), "utf8");
    } catch {
      // Usage history is best-effort: it must never alter the proxy response path.
    }
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isHourBucket(parsed)) {
          this.observe(parsed.h);
          // A line with no `cost` predates prices: keep it as legacy, to be priced when a summary reads it.
          const stored = parsed as Partial<Priced>;
          const legacy = stored.cost === undefined;
          this.merge(this.buckets, { ...parsed, cost: stored.cost ?? 0, unpriced: stored.unpriced ?? 0, estimated: stored.estimated ?? 0, ...(legacy ? { legacy: true as const } : {}) });
        }
      } catch {
        // A torn write stays behind; the neighbouring lines still count.
      }
    }
  }
}

function hourOf(record: RequestRecord): number | null {
  const at = Date.parse(record.at);
  return Number.isFinite(at) ? Math.floor(at / HOUR_MS) : null;
}
