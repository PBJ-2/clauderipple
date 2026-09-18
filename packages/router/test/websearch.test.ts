import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicServerToolBackend, dedupeHits, hitsFromServerToolResult, webSearchBlocks, webSearchErrorBlocks, webSearchMessage, webSearchQuery } from "../src/websearch.ts";

// The real shape, read from the Claude Code binary 2.1.271: one forced server tool, one message.
const sideRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "deepseek-flash",
  max_tokens: 1024,
  system: [{ type: "text", text: "You are an assistant for performing a web search tool use" }],
  messages: [{ role: "user", content: "Perform a web search for the query: Node.js 24 LTS release date" }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
  tool_choice: { type: "tool", name: "web_search" },
  ...over,
});

test("the web-search side request is recognised by its forced server tool, not by its model", () => {
  const q = webSearchQuery(sideRequest());
  assert.equal(q?.query, "Node.js 24 LTS release date", "the prefix the CLI writes is stripped");
  assert.equal(q?.maxUses, 8);

  // The model id is whatever ANTHROPIC_SMALL_FAST_MODEL was pointed at, so it must not be part of the test.
  assert.equal(webSearchQuery(sideRequest({ model: "gpt-5.6-terra" }))?.query, "Node.js 24 LTS release date");
});

test("domain filters ride on the tool definition", () => {
  const q = webSearchQuery(sideRequest({
    tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["nodejs.org"], blocked_domains: [] }],
  }));
  assert.deepEqual(q?.allowedDomains, ["nodejs.org"]);
  assert.equal(q?.blockedDomains, undefined, "an empty list is not a filter");
});

test("an ordinary turn is left alone, however much it looks like one", () => {
  assert.equal(webSearchQuery({ model: "x", messages: [{ role: "user", content: "search the web for node 24" }] }), null);
  // A real turn carries its own tools beside any hosted one; answering it here would replace a
  // model's reply with a search result.
  assert.equal(webSearchQuery(sideRequest({
    tools: [{ type: "web_search_20250305", name: "web_search" }, { name: "Read", input_schema: { type: "object" } }],
  })), null);
  assert.equal(webSearchQuery(sideRequest({ tools: [{ type: "custom", name: "web_search" }] })), null);
  assert.equal(webSearchQuery(sideRequest({ messages: [] })), null);
  // A conversation, rather than the CLI's one fixed sentence, is not the side request.
  assert.equal(webSearchQuery(sideRequest({
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
  })), null);
  assert.equal(webSearchQuery(sideRequest({ messages: [{ role: "user", content: "just search for node 24 please" }] })), null);
});

// The CLI source forces the tool; the wire says otherwise, and the wire is what we serve.
test("the side request is served even though its tool_choice arrives as auto", () => {
  const q = webSearchQuery(sideRequest({ tool_choice: { type: "auto" } }));
  assert.equal(q?.query, "Node.js 24 LTS release date");
});

test("hits are de-duplicated by URL, ignoring trailing slash, query and fragment", () => {
  const hits = dedupeHits([
    { title: "A", url: "https://nodejs.org/en/blog/release/v24.11.0" },
    { title: "A again", url: "https://nodejs.org/en/blog/release/v24.11.0/" },
    { title: "A tracked", url: "https://nodejs.org/en/blog/release/v24.11.0?utm_source=x" },
    { title: "B", url: "https://nodejs.org/en/blog/migrations/v22-to-v24" },
  ]);
  assert.deepEqual(hits.map((h) => h.title), ["A", "B"]);
});

test("a hit with no title falls back to its URL rather than rendering blank", () => {
  assert.deepEqual(dedupeHits([{ title: "", url: "https://example.test/a" }]), [{ title: "https://example.test/a", url: "https://example.test/a" }]);
});

test("blocks are the shape Claude Code parses, and the search count is reported", () => {
  const q = webSearchQuery(sideRequest())!;
  const { blocks, toolUseId } = webSearchBlocks(q, {
    hits: [{ title: "Node.js 24.11.0 (LTS)", url: "https://nodejs.org/en/blog/release/v24.11.0" }],
    text: "Node.js 24 became LTS in 24.11.0.",
  });
  assert.deepEqual(blocks.map((b) => b.type), ["server_tool_use", "web_search_tool_result", "text"]);
  assert.equal((blocks[0] as { name: string }).name, "web_search");
  assert.deepEqual((blocks[0] as { input: unknown }).input, { query: "Node.js 24 LTS release date" });
  assert.equal((blocks[1] as { tool_use_id: string }).tool_use_id, toolUseId, "the result must name the call it answers");
  assert.deepEqual((blocks[1] as { content: unknown[] }).content, [
    { type: "web_search_result", title: "Node.js 24.11.0 (LTS)", url: "https://nodejs.org/en/blog/release/v24.11.0" },
  ]);

  // "Did N searches" comes from this field; leaving it out reports zero for a search that ran.
  const msg = webSearchMessage("deepseek-flash", blocks, 1);
  assert.deepEqual((msg.usage as { server_tool_use: unknown }).server_tool_use, { web_search_requests: 1 });
  assert.equal(msg.stop_reason, "end_turn");
});

test("no prose means no empty text block", () => {
  const q = webSearchQuery(sideRequest())!;
  const { blocks } = webSearchBlocks(q, { hits: [{ title: "A", url: "https://example.test/a" }], text: "   " });
  assert.deepEqual(blocks.map((b) => b.type), ["server_tool_use", "web_search_tool_result"]);
});

test("a failed search says so in the shape the CLI prints, rather than returning nothing", () => {
  const q = webSearchQuery(sideRequest())!;
  const blocks = webSearchErrorBlocks(q, "unavailable");
  assert.deepEqual((blocks[1] as { content: unknown }).content, { type: "web_search_tool_result_error", error_code: "unavailable" });
});

// A provider that runs the server tool itself answers in Anthropic's own shape, so the backend is
// mostly a relay. What it must not relay is a polite non-answer.
test("the anthropic server-tool backend asks in Anthropic's shape and reads the result blocks", async () => {
  let sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent = { url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers };
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "Node.js 24 LTS release date" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
            { type: "web_search_result", title: "Node.js 24.11.0 (LTS)", url: "https://nodejs.org/en/blog/release/v24.11.0" },
            { type: "web_search_result", title: "Releases", url: "https://nodejs.org/en/about/previous-releases" },
            { type: "web_search_result", title: "dup", url: "https://nodejs.org/en/about/previous-releases" },
          ] },
          { type: "text", text: "Node.js 24 entered LTS in October 2025." },
        ],
      }),
    };
  }) as unknown as typeof fetch;

  const backend = anthropicServerToolBackend({
    name: "deepseek", url: "https://api.deepseek.com/anthropic/", headers: { "x-api-key": "k" },
    model: "deepseek-chat", fetchImpl,
  });
  const outcome = await backend.search({ query: "Node.js 24 LTS release date", maxUses: 8 });

  const call = sent as unknown as { url: string; body: Record<string, unknown>; headers: Record<string, string> };
  assert.equal(call.url, "https://api.deepseek.com/anthropic/v1/messages", "the trailing slash does not double up");
  assert.equal(call.headers["x-api-key"], "k");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(call.body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]);
  assert.deepEqual(call.body.tool_choice, { type: "tool", name: "web_search" });

  assert.deepEqual(outcome.hits.map((h) => h.url), [
    "https://nodejs.org/en/blog/release/v24.11.0",
    "https://nodejs.org/en/about/previous-releases",
  ], "the repeated url is folded");
  assert.equal(outcome.text, "Node.js 24 entered LTS in October 2025.");
});

// Measured 2026-09-18: OpenCode Go's DeepSeek, handed this request, answered with its own tool-call
// markup as plain text and ran no search at all. Returning that as a result is the silent failure
// this module exists to prevent, so it has to raise.
test("prose with no result blocks is a failure, not an answer", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: '<｜｜DSML｜｜ invoke name="web_search">…' }] }),
  })) as unknown as typeof fetch;
  const backend = anthropicServerToolBackend({ name: "opencode-go", url: "https://x.test", headers: {}, model: "deepseek-v4.1-flash", fetchImpl });
  await assert.rejects(() => backend.search({ query: "anything" }), /no results returned/);
});

test("an http failure names the backend rather than surfacing as a transport error", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 402, json: async () => ({}) })) as unknown as typeof fetch;
  const backend = anthropicServerToolBackend({ name: "deepseek", url: "https://x.test", headers: {}, model: "m", fetchImpl });
  await assert.rejects(() => backend.search({ query: "anything" }), /deepseek web search: HTTP 402/);
});

test("only web_search_result entries count as hits", () => {
  assert.deepEqual(hitsFromServerToolResult([
    { type: "web_search_result", title: "A", url: "https://a.test" },
    { type: "web_search_tool_result_error", error_code: "unavailable" },
    { type: "web_search_result", url: "https://b.test" },
    { type: "web_search_result", title: "no url" },
  ]), [{ title: "A", url: "https://a.test" }, { title: "https://b.test", url: "https://b.test" }]);
  assert.deepEqual(hitsFromServerToolResult(undefined), []);
});
