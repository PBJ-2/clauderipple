// Web search for routed models.
//
// Claude Code does not put `web_search` in the main request. `WebSearch` opens a separate side
// request — system prompt "You are an assistant for performing a web search tool use", one message
// "Perform a web search for the query: …", one Anthropic `web_search` server tool, `max_uses: 8` —
// and sends it to `ANTHROPIC_SMALL_FAST_MODEL` when that is set, otherwise to a built-in small
// model (measured 2026-09-17: an Opus session and a DeepSeek-routed session both landed on
// `claude-haiku-4-5`).
//
// That is why web search costs Anthropic quota no matter which provider answers the session: without
// a Claude subscription a user on DeepSeek or GPT cannot search at all, which makes a routed setup
// only half routed. This module answers that side request from the provider's own hosted search —
// the one the user already pays for.
//
// The side request needs no env var to reach us: we terminate TLS for api.anthropic.com, so every
// request passes through, and the interception happens before routing. Its model id is therefore
// irrelevant, which is just as well, because it is whatever the CLI picked.
//
// The answer must be shaped the way Claude Code parses it: the CLI reads `server_tool_use` blocks
// to count searches, `web_search_tool_result` blocks for the hits, and `text` blocks for prose,
// then reports "Did N searches" from `usage.server_tool_use.web_search_requests`. Get the count
// field wrong and a search that really ran is reported as zero.

import crypto from "node:crypto";

/** What the side request asked for. `allowedDomains`/`blockedDomains` ride on the tool definition. */
export type WebSearchQuery = {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
};

/** One hit. Claude Code keeps only these two fields; snippets are dropped inside the CLI. */
export type SearchHit = { title: string; url: string };

export type SearchOutcome = {
  hits: SearchHit[];
  /** Optional prose to accompany the hits, for backends that produce one. */
  text?: string;
};

/**
 * A source of search results — in practice a provider's own hosted search, billed to the account the
 * user already has with it. The one thing a backend must not be is Anthropic: routing the session
 * away from Claude and then searching on Claude quota is the failure this whole path exists to fix.
 *
 * A backend that cannot answer throws, and the caller falls back to the ordinary routed path rather
 * than inventing an empty result: a search that silently returns nothing is the worst outcome here.
 */
export type SearchBackend = {
  readonly name: string;
  search(q: WebSearchQuery, signal?: AbortSignal): Promise<SearchOutcome>;
};

const QUERY_PREFIX = "Perform a web search for the query: ";

function isWebSearchTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  const { type, name } = tool as { type?: unknown; name?: unknown };
  // The type carries a date suffix (`web_search_20250305`) that changes with the tool version.
  return typeof type === "string" && type.startsWith("web_search") && name === "web_search";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The side request's query, or null when this is an ordinary turn. Recognised by the forced server
 * tool rather than by the model id, because the model id is whatever the user pointed
 * `ANTHROPIC_SMALL_FAST_MODEL` at.
 */
export function webSearchQuery(json: Record<string, unknown>): WebSearchQuery | null {
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const tool = tools.find(isWebSearchTool) as { allowed_domains?: unknown; blocked_domains?: unknown; max_uses?: unknown } | undefined;
  if (!tool) return null;

  // The side request declares that one tool and nothing else — an ordinary turn carries Read, Edit,
  // Bash and the rest — and its single user message is the CLI's fixed sentence. Both are required,
  // because hijacking a turn that wanted a model would be far worse than missing a search.
  //
  // What is deliberately NOT required is a forced `tool_choice`. The CLI source passes
  // `toolChoice: {type:"tool", name:"web_search"}`, but the wire carries `{"type":"auto"}`
  // (measured 2026-09-17 against the live side request). Read the wire, not the source.
  if (tools.length !== 1) return null;

  const messages = Array.isArray(json.messages) ? json.messages : [];
  if (messages.length !== 1) return null;
  const asked = textOf((messages[0] as { content?: unknown }).content).trim();
  if (!asked.startsWith(QUERY_PREFIX)) return null;
  const query = asked.slice(QUERY_PREFIX.length).trim();
  if (!query) return null;

  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") && v.length > 0 ? (v as string[]) : undefined;
  const allowed = strings(tool.allowed_domains);
  const blocked = strings(tool.blocked_domains);
  return {
    query,
    ...(allowed ? { allowedDomains: allowed } : {}),
    ...(blocked ? { blockedDomains: blocked } : {}),
    ...(typeof tool.max_uses === "number" ? { maxUses: tool.max_uses } : {}),
  };
}

/**
 * Hits out of an OpenAI-shaped Chat Completions reply that used a web plugin. OpenRouter returns
 * them as `message.annotations[].url_citation` (verified live 2026-09-17: four citations with title
 * and url, plus prose, for `plugins: [{id:"web"}]`). Vendors that answer the same schema without
 * annotations simply yield no hits, and the caller falls back rather than pretending.
 */
export function hitsFromAnnotations(message: unknown): SearchOutcome {
  const m = (message ?? {}) as { annotations?: unknown; content?: unknown };
  const annotations = Array.isArray(m.annotations) ? m.annotations : [];
  const hits: SearchHit[] = [];
  for (const a of annotations) {
    if (!a || typeof a !== "object") continue;
    const cite = (a as { type?: unknown; url_citation?: unknown }).url_citation as { url?: unknown; title?: unknown } | undefined;
    if ((a as { type?: unknown }).type !== "url_citation" || !cite || typeof cite.url !== "string") continue;
    hits.push({ title: typeof cite.title === "string" ? cite.title : cite.url, url: cite.url });
  }
  const text = typeof m.content === "string" ? m.content : "";
  return { hits, ...(text ? { text } : {}) };
}

/** Same-host duplicates waste the model's attention; the CLI does not de-duplicate for us. */
export function dedupeHits(hits: SearchHit[], limit = 10): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (!hit?.url || typeof hit.url !== "string") continue;
    const key = hit.url.replace(/[#?].*$/, "").replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: typeof hit.title === "string" && hit.title ? hit.title : hit.url, url: hit.url });
    if (out.length >= limit) break;
  }
  return out;
}

export type AnthropicBlockOut = Record<string, unknown>;

/**
 * The content blocks Claude Code's own parser expects: a `server_tool_use` it counts, a
 * `web_search_tool_result` it reads hits from, and any prose as `text`.
 */
export function webSearchBlocks(q: WebSearchQuery, outcome: SearchOutcome): { blocks: AnthropicBlockOut[]; toolUseId: string } {
  const toolUseId = `srvtoolu_${crypto.randomBytes(12).toString("hex")}`;
  const hits = dedupeHits(outcome.hits);
  const blocks: AnthropicBlockOut[] = [
    { type: "server_tool_use", id: toolUseId, name: "web_search", input: { query: q.query } },
    {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: hits.map((h) => ({ type: "web_search_result", title: h.title, url: h.url })),
    },
  ];
  const text = outcome.text?.trim();
  if (text) blocks.push({ type: "text", text });
  return { blocks, toolUseId };
}

/** The error shape the CLI recognises: it prints `Web search error: <code>` rather than showing nothing. */
export function webSearchErrorBlocks(q: WebSearchQuery, errorCode: string): AnthropicBlockOut[] {
  const toolUseId = `srvtoolu_${crypto.randomBytes(12).toString("hex")}`;
  return [
    { type: "server_tool_use", id: toolUseId, name: "web_search", input: { query: q.query } },
    { type: "web_search_tool_result", tool_use_id: toolUseId, content: { type: "web_search_tool_result_error", error_code: errorCode } },
  ];
}

/**
 * A complete non-streaming Messages response. `usage.server_tool_use.web_search_requests` is what
 * the CLI turns into "Did N searches"; omitting it reports zero for a search that ran.
 */
export function webSearchMessage(model: string, blocks: AnthropicBlockOut[], searches: number): Record<string, unknown> {
  return {
    id: `msg_${crypto.randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: searches },
    },
  };
}

/**
 * The same message as a stream. Claude Code assembles the final content from these events and only
 * then parses it, so what matters is that the assembled message matches `webSearchMessage`; the
 * events also drive the "Searching…" progress line.
 */
export function webSearchSse(model: string, blocks: AnthropicBlockOut[], searches: number): string {
  const message = webSearchMessage(model, blocks, searches);
  const frames: { event: string; data: Record<string, unknown> }[] = [
    { event: "message_start", data: { type: "message_start", message: { ...message, content: [] } } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      frames.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      frames.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: String(block.text ?? "") } } });
    } else {
      // A server tool block carries no deltas: it is complete the moment it opens.
      frames.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: block } });
    }
    frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  frames.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: message.usage } });
  frames.push({ event: "message_stop", data: { type: "message_stop" } });
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
}

/**
 * A backend that asks an OpenAI-compatible provider to search with its own hosted web plugin.
 * OpenRouter takes `plugins: [{id:"web"}]` and answers with `url_citation` annotations; `:online`
 * on the model id is the same thing, and is not used here because the plugin form carries the
 * domain filters and result count the side request asked for.
 */
export function webPluginBackend(opts: {
  name: string;
  /** Provider base url, as configured (`https://openrouter.ai/api`); `/v1/chat/completions` is appended. */
  url: string;
  headers: Record<string, string>;
  model: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}): SearchBackend {
  return {
    name: opts.name,
    async search(q, signal) {
      const plugin: Record<string, unknown> = { id: "web", max_results: opts.maxResults ?? 5 };
      if (q.allowedDomains) plugin.include_domains = q.allowedDomains;
      else if (q.blockedDomains) plugin.exclude_domains = q.blockedDomains;
      const body = {
        model: opts.model,
        plugins: [plugin],
        messages: [{ role: "user", content: `${QUERY_PREFIX}${q.query}` }],
        max_tokens: 700,
      };
      const doFetch = opts.fetchImpl ?? fetch;
      const res = await doFetch(`${opts.url.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`${opts.name} web search: HTTP ${res.status}`);
      const json = await res.json() as { choices?: { message?: unknown }[] };
      const outcome = hitsFromAnnotations(json.choices?.[0]?.message);
      // No citations means the plugin did not run. Say so rather than handing back a confident
      // summary with nothing behind it.
      if (outcome.hits.length === 0) throw new Error(`${opts.name} web search: no citations returned`);
      return outcome;
    },
  };
}
