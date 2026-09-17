import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeHits, webSearchBlocks, webSearchErrorBlocks, webSearchMessage, webSearchQuery } from "../src/websearch.ts";

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
