import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLog, ResponseUsageTap, openRequestLog, type RequestRecord } from "../src/requestlog.ts";
import { setAaPriceDataset } from "../src/prices.ts";

function record(id: string, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id,
    at: "2026-09-13T10:00:00.000Z",
    ms: 100,
    status: 200,
    ok: true,
    kind: "messages",
    source: "claude-opus",
    target: "gpt-test",
    provider: "chatgpt",
    stream: true,
    ...overrides,
  };
}

test("RequestLog keeps a bounded ring and reloads persisted JSONL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-log-"));
  const file = path.join(dir, "requests.jsonl");
  try {
    const log = new RequestLog(file, 2);
    log.add(record("one"));
    log.add(record("two", { provider: "anthropic" }));
    log.add(record("three"));
    assert.deepEqual(log.list(10).map((r) => r.id), ["three", "two"]);
    assert.deepEqual(log.list(10, { provider: "chatgpt" }).map((r) => r.id), ["three"]);
    log.add(record("four", { session: "s-1" }));
    assert.deepEqual(log.list(10, { session: "s-1" }).map((r) => r.id), ["four"]);
    assert.deepEqual(log.list(10, { session: "s-2" }), []);
    const reloaded = new RequestLog(file, 2);
    assert.deepEqual(reloaded.list(10).map((r) => r.id), ["four", "three"]);
    assert.equal(reloaded.list(1)[0]!.session, "s-1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an image record persists, reloads and counts under the image target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-image-"));
  try {
    const file = path.join(dir, "requests.jsonl");
    const log = new RequestLog(file);
    log.add(record("image-1", {
      at: "2026-10-21T10:00:00.000Z",
      kind: "image",
      source: "gpt-6-astra",
      target: "image",
      provider: "gpt",
      stream: false,
      usage: { input: 2249, cached: 0, output: 75 },
      note: "1536x1024 low png, 1 reference(s)",
    }));
    log.add(record("turn"));
    assert.deepEqual(log.list(10, { kind: "image" }).map((r) => r.id), ["image-1"]);
    // A filter may name several kinds; a record matches any of them.
    assert.deepEqual(log.list(10, { kind: ["messages", "image"] }).map((r) => r.id), ["turn", "image-1"]);
    assert.deepEqual(log.list(10, { kind: ["count_tokens"] }), []);

    const reloaded = new RequestLog(file);
    assert.equal(reloaded.list(1, { kind: "image" })[0]!.kind, "image");
    const usage = reloaded.usage(Date.parse("2026-10-21T10:00:00.000Z"), Date.parse("2026-10-21T11:00:00.000Z"));
    assert.equal(usage.providers.gpt?.count, 1);
    assert.deepEqual(usage.models.map((m) => [m.provider, m.model, m.input]), [["gpt", "image", 2249]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RequestLog computes success, usage, cache and latency summaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-summary-"));
  try {
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    log.add(record("a", { at: "2026-09-13T10:00:00.000Z", ms: 100, usage: { input: 20, cached: 80, output: 9 } }));
    log.add(record("b", { at: "2026-09-13T10:01:00.000Z", ms: 300, ok: false, status: 502, provider: "moonshot", usage: { input: 50, cached: 0, output: 0 } }));
    // A cache write is input that missed: 98 read of 2 + 98 + 100 is a 49% hit, not 98%.
    log.add(record("c", { at: "2026-09-13T10:02:00.000Z", ms: 200, provider: "anthropic", usage: { input: 2, cached: 98, cacheWrite: 100, output: 1 } }));
    log.add(record("old", { at: "2026-09-13T09:00:00.000Z", usage: { input: 999, cached: 0, output: 999 } }));
    const summary = log.summary(Date.parse("2026-09-13T09:59:00.000Z"));
    // No AA prices are loaded here, so every request with tokens is unpriced and costs nothing.
    assert.deepEqual(summary.total, { count: 3, ok: 2, failed: 1, input: 72, cached: 178, cacheWrite: 100, output: 10, cacheHitPercent: 50.9, avgMs: 200, conversationTokens: 360, ungroupedRequests: 3, costUsd: 0, unpricedRequests: 3, estimatedRequests: 0 });
    assert.deepEqual(summary.providers.chatgpt, { count: 1, ok: 1, failed: 0, input: 20, cached: 80, cacheWrite: 0, output: 9, cacheHitPercent: 80, avgMs: 100, conversationTokens: 109, ungroupedRequests: 1, costUsd: 0, unpricedRequests: 1, estimatedRequests: 0 });
    assert.deepEqual(summary.providers.moonshot, { count: 1, ok: 0, failed: 1, input: 50, cached: 0, cacheWrite: 0, output: 0, cacheHitPercent: 0, avgMs: 300, conversationTokens: 50, ungroupedRequests: 1, costUsd: 0, unpricedRequests: 1, estimatedRequests: 0 });
    assert.deepEqual(summary.providers.anthropic, { count: 1, ok: 1, failed: 0, input: 2, cached: 98, cacheWrite: 100, output: 1, cacheHitPercent: 49, avgMs: 200, conversationTokens: 201, ungroupedRequests: 1, costUsd: 0, unpricedRequests: 1, estimatedRequests: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a web search is its own model row, and a record from before the flag reads the same way", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-websearch-"));
  try {
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    // The router's shape now: the flag, the model id the search ran on, and the tokens it read.
    log.add(record("search", { at: "2026-10-26T10:00:00.000Z", provider: "chatgpt", target: "gpt-6-luna", purpose: "web-search", note: "web search via chatgpt", usage: { input: 60, cached: 40, output: 10 } }));
    // The old shape: no flag, "<provider>/<model>" in target, and no tokens at all.
    log.add(record("old-search", { at: "2026-10-26T10:01:00.000Z", provider: "chatgpt", target: "chatgpt/gpt-6-luna", note: "web search via chatgpt" }));
    // The same model's own turn and a vendor-namespaced model id under a provider of that name.
    log.add(record("turn", { at: "2026-10-26T10:02:00.000Z", provider: "chatgpt", target: "gpt-6-luna", usage: { input: 1000, cached: 0, output: 50 } }));
    log.add(record("vendor", { at: "2026-10-26T10:03:00.000Z", provider: "zai-org", target: "zai-org/glm-5.3-flash", usage: { input: 10, cached: 0, output: 1 } }));

    // Readers see the old search as the current code writes one.
    const old = log.list(10).find((entry) => entry.id === "old-search")!;
    assert.equal(old.purpose, "web-search");
    assert.equal(old.target, "gpt-6-luna");

    const rows = log.summary(Date.parse("2026-10-26T00:00:00.000Z")).models;
    const rowOf = (model: string, purpose?: "web-search") => rows.find((entry) => entry.model === model && entry.purpose === purpose);
    assert.deepEqual(
      { count: rowOf("gpt-6-luna", "web-search")?.count, input: rowOf("gpt-6-luna", "web-search")?.input, cached: rowOf("gpt-6-luna", "web-search")?.cached, output: rowOf("gpt-6-luna", "web-search")?.output },
      { count: 2, input: 60, cached: 40, output: 10 },
    );
    // The model's own turn stays a row of its own.
    assert.equal(rowOf("gpt-6-luna")?.count, 1);
    assert.equal(rowOf("gpt-6-luna")?.input, 1000);
    // A vendor-namespaced id is a model row, not a search row.
    assert.equal(rowOf("zai-org/glm-5.3-flash")?.count, 1);
    assert.equal(rowOf("zai-org/glm-5.3-flash")?.purpose, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a resent request is counted, but neither as a success nor as a failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-resent-"));
  try {
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    log.add(record("a", { at: "2026-10-07T10:00:00.000Z", ms: 300, ok: false, status: 404, provider: "anthropic", resent: true }));
    log.add(record("b", { at: "2026-10-07T10:00:01.000Z", ms: 100, provider: "anthropic" }));
    const summary = log.summary(Date.parse("2026-10-07T09:59:00.000Z"));
    assert.equal(summary.total.count, 2);
    assert.equal(summary.total.ok, 1);
    assert.equal(summary.total.failed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RequestLog rotates once at its configured size and keeps one previous file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-rotate-"));
  const file = path.join(dir, "requests.jsonl");
  try {
    const log = new RequestLog(file, 100, 300);
    log.add(record("one", { note: "x".repeat(180) }));
    log.add(record("two", { note: "y".repeat(180) }));
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(`${file}.1`));
    assert.match(fs.readFileSync(`${file}.1`, "utf8"), /"id":"one"/);
    assert.match(fs.readFileSync(file, "utf8"), /"id":"two"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ResponseUsageTap extracts split Anthropic SSE fields without changing forwarded bytes", () => {
  const body = [
    "event: message_start\n",
    "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":40,\"cache_creation_input_tokens\":7,\"output_tokens\":0}}}\n\n",
    "event: message_delta\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":40,\"cache_creation_input_tokens\":7,\"output_tokens\":25}}\n\n",
  ].join("");
  const pieces = [Buffer.from(body.slice(0, 31)), Buffer.from(body.slice(31, 119)), Buffer.from(body.slice(119, 231)), Buffer.from(body.slice(231))];
  const tap = new ResponseUsageTap("text/event-stream", "identity");
  const forwarded: Buffer[] = [];
  for (const piece of pieces) {
    forwarded.push(piece); // exactly what the proxy writes before observing it
    tap.feed(piece);
  }
  assert.deepEqual(Buffer.concat(forwarded), Buffer.from(body));
  assert.deepEqual(tap.finish(), { usage: { input: 100, cached: 40, cacheWrite: 7, output: 25 }, stopReason: "end_turn" });
});

test("ResponseUsageTap skips compressed responses and bounds unbroken input", () => {
  const compressed = new ResponseUsageTap("text/event-stream", "gzip");
  compressed.feed(Buffer.from("event: message_delta\ndata: {}\n\n"));
  assert.deepEqual(compressed.finish(), {});
  const plain = new ResponseUsageTap("text/event-stream", "identity");
  plain.feed(Buffer.from("x".repeat(70 * 1024)));
  assert.deepEqual(plain.finish(), {});
});

test("ResponseUsageTap inflates a gzip SSE stream side-band", async () => {
  const { ResponseUsageTap } = await import("../src/requestlog.ts");
  const zlib = await import("node:zlib");
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  ].join("");
  const gz = zlib.gzipSync(Buffer.from(sse));
  const tap = new ResponseUsageTap("text/event-stream", "gzip");
  for (let i = 0; i < gz.length; i += 7) tap.feed(gz.subarray(i, i + 7));
  const r = tap.finish();
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.usage?.input, 100);
  assert.equal(r.usage?.cached, 900);
  assert.equal(r.usage?.output, 42);
});

test("ResponseUsageTap keeps usage when a whole SSE body over 64KiB arrives at once (#55)", async () => {
  const zlib = await import("node:zlib");
  const delta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + "a".repeat(200) + '"}}\n\n';
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":7,"output_tokens":1}}}\n\n',
    delta.repeat(400),
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
  ].join("");
  assert.ok(sse.length > 64 * 1024);
  const expected = { usage: { input: 100, cached: 900, cacheWrite: 7, output: 42 }, stopReason: "end_turn" };
  const gzip = new ResponseUsageTap("text/event-stream", "gzip");
  gzip.feed(zlib.gzipSync(Buffer.from(sse)));
  assert.deepEqual(gzip.finish(), expected);
  const plain = new ResponseUsageTap("text/event-stream", "identity");
  plain.feed(Buffer.from(sse));
  assert.deepEqual(plain.finish(), expected);
});

test("ResponseUsageTap distinguishes explicit cache writes from absent/non-number values", () => {
  for (const stream of [false, true]) {
    for (const value of [0, 7, undefined, null, "0"]) {
      const usage = { input_tokens: 5, output_tokens: 1, ...(value !== undefined ? { cache_creation_input_tokens: value } : {}) };
      const tap = new ResponseUsageTap(stream ? "text/event-stream" : "application/json", undefined);
      tap.feed(Buffer.from(stream
        ? `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\n`
        : JSON.stringify({ usage })));
      if (stream) tap.feed(Buffer.from('event: message_delta\ndata: {"usage":{"output_tokens":9}}\n\n'));
      assert.deepEqual(tap.finish().usage, { input: 5, cached: 0, ...(typeof value === "number" ? { cacheWrite: value } : {}), output: stream ? 9 : 1 });
    }
  }
});

test("ResponseUsageTap observes only the message id and reported tier, across split JSON/SSE", () => {
  const message = { content: [{ id: "tool-id", text: 'quoted "id":"prompt-id"' }], id: "msg_actual", usage: { input_tokens: 1, service_tier: "standard" } };
  for (const stream of [false, true]) {
    const text = stream ? `event: message_start\ndata: ${JSON.stringify({ message })}\n\n` : JSON.stringify(message);
    const tap = new ResponseUsageTap(stream ? "text/event-stream" : "application/json", undefined);
    for (const char of text) tap.feed(Buffer.from(char));
    assert.deepEqual(tap.finish(), { messageId: "msg_actual", servedTier: "standard", usage: { input: 1, cached: 0, output: 0 } });
  }
  const absent = new ResponseUsageTap("application/json", undefined);
  absent.feed(Buffer.from(JSON.stringify({ content: [{ id: "tool-id" }], usage: { input_tokens: 1, service_tier: null } })));
  assert.deepEqual(absent.finish(), { usage: { input: 1, cached: 0, output: 0 } });
});

function tapJson(chunks: Buffer[]): ReturnType<ResponseUsageTap["finish"]> {
  const tap = new ResponseUsageTap("application/json", undefined);
  for (const chunk of chunks) tap.feed(chunk);
  return tap.finish();
}

test("ResponseUsageTap reads the top-level usage, not one nested in a tool input (B12)", () => {
  const body = {
    id: "msg_top",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "probe",
        input: {
          usage: { input_tokens: 999, cache_read_input_tokens: 888, cache_creation_input_tokens: 777, output_tokens: 666, service_tier: "bogus" },
          items: [{ usage: { input_tokens: 555, output_tokens: 444 } }],
          note: 'quoted "usage":{"input_tokens":333,"output_tokens":222}',
        },
      },
      { type: "tool_result", content: [{ type: "text", text: "plain" }] },
    ],
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 3, service_tier: "standard" },
  };
  const text = JSON.stringify(body);
  const expected = { messageId: "msg_top", servedTier: "standard", usage: { input: 10, cached: 20, cacheWrite: 5, output: 3 } };
  // A non-streaming body often arrives whole; the nested and top-level usage share that chunk.
  assert.deepEqual(tapJson([Buffer.from(text)]), expected);
  assert.deepEqual(tapJson([Buffer.from(text.slice(0, 40)), Buffer.from(text.slice(40))]), expected);
  assert.deepEqual(tapJson([...text].map((char) => Buffer.from(char))), expected);
  // The top-level object can also precede the tool input; a later nested usage must not replace it.
  const reordered = '{"usage":{"input_tokens":6,"output_tokens":1},"content":[{"type":"tool_use","input":{"usage":{"input_tokens":999,"output_tokens":888}}}]}';
  assert.deepEqual(tapJson([Buffer.from(reordered)]), { usage: { input: 6, cached: 0, output: 1 } });
});

test("ResponseUsageTap does not inherit fields from a nested usage across chunks (B12)", () => {
  const head = '{"id":"msg_x","content":[{"input":{"usage":{"input_tokens":999,"cache_read_input_tokens":888,"output_tokens":777}}}],';
  const tail = '"usage":{"input_tokens":5,"output_tokens":2}}';
  // The nested usage completes in the first chunk; the top-level one arrives in the next and
  // reports no cache read, so a leaked 888 from the tool input would show.
  assert.deepEqual(tapJson([Buffer.from(head), Buffer.from(tail)]), { messageId: "msg_x", usage: { input: 5, cached: 0, output: 2 } });
});

test("ResponseUsageTap ignores usage-shaped text inside JSON strings (B12)", () => {
  const body = {
    id: "msg_text",
    content: [{ type: "text", text: 'note: "usage":{"input_tokens":999,"cache_read_input_tokens":888,"output_tokens":777}' }],
    usage: { input_tokens: 4, output_tokens: 2 },
  };
  const text = JSON.stringify(body);
  const expected = { messageId: "msg_text", usage: { input: 4, cached: 0, output: 2 } };
  assert.deepEqual(tapJson([Buffer.from(text)]), expected);
  assert.deepEqual(tapJson([...text].map((char) => Buffer.from(char))), expected);
});

test("ResponseUsageTap finds the top-level usage after a large tool input and survives a truncated body (B12)", () => {
  const filler = '{"usage":{"input_tokens":999,"output_tokens":888}}' + "a".repeat(100 * 1024);
  const body = { id: "msg_big", content: [{ type: "text", text: filler }], usage: { input_tokens: 7, cache_read_input_tokens: 8, output_tokens: 9 } };
  const text = JSON.stringify(body);
  assert.ok(text.length > 100 * 1024);
  const chunks: Buffer[] = [];
  for (let i = 0; i < text.length; i += 8192) chunks.push(Buffer.from(text.slice(i, i + 8192)));
  assert.deepEqual(tapJson(chunks), { messageId: "msg_big", usage: { input: 7, cached: 8, output: 9 } });

  assert.deepEqual(tapJson([Buffer.from('{"id":"msg_trunc","usage":{"input_tokens":12,"cache_read')]), { messageId: "msg_trunc" });
  assert.deepEqual(tapJson([Buffer.from('{"id":"msg_trunc","content":[{"usage":{"input_tokens":12')]), { messageId: "msg_trunc" });
});

test("ResponseUsageTap reports no usage for empty, missing or non-object usage (B12)", () => {
  assert.deepEqual(tapJson([Buffer.from("{}")]), {});
  assert.deepEqual(tapJson([Buffer.from('{"id":"msg_only"}')]), { messageId: "msg_only" });
  assert.deepEqual(tapJson([Buffer.from('{"id":"msg_null","usage":null}')]), { messageId: "msg_null" });
});

test("ResponseUsageTap drops an over-long SSE line whole and reads the events after it", () => {
  const tap = new ResponseUsageTap("text/event-stream", "identity");
  tap.feed(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n'));
  tap.feed(Buffer.from("data: " + "x".repeat(70 * 1024)));
  tap.feed(Buffer.from('data: {"type":"message_delta"}\n\n'));
  tap.feed(Buffer.from('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n'));
  assert.deepEqual(tap.finish(), { usage: { input: 5, cached: 0, output: 9 }, stopReason: "end_turn" });
});

test("thinking provenance holds no oversized or unbounded fields while blocks are open", () => {
  const seen: string[] = [];
  const tap = new ResponseUsageTap("text/event-stream", undefined, block => seen.push(String(block.data ?? block.signature)));
  const sse = (body: unknown): Buffer => Buffer.from(`data: ${JSON.stringify(body)}\n\n`);
  // One field over the per-block bound is never held, so its origin stays unknown.
  tap.feed(sse({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "x".repeat(64 * 1024 + 1) } }));
  // Many open blocks under the per-block bound stop being held once the response-wide bound is reached.
  for (let index = 1; index <= 8; index++) tap.feed(sse({ type: "content_block_start", index, content_block: { type: "redacted_thinking", data: `${index}:` + "y".repeat(60 * 1024) } }));
  for (let index = 0; index <= 8; index++) tap.feed(sse({ type: "content_block_stop", index }));
  assert.deepEqual(seen.map(data => data.split(":")[0]), ["1", "2", "3", "4"]);
  // Closing them returns the budget: a later small block is held again.
  tap.feed(sse({ type: "content_block_start", index: 9, content_block: { type: "thinking", signature: "" } }));
  tap.feed(sse({ type: "content_block_delta", index: 9, delta: { type: "signature_delta", signature: "small" } }));
  tap.feed(sse({ type: "content_block_stop", index: 9 }));
  assert.equal(seen.at(-1), "small");
});

test("a restart replays the unflushed hours priced from the AA cache on disk, not as unpriced", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-request-replay-"));
  try {
    fs.writeFileSync(path.join(home, "aa-models.json"), JSON.stringify({
      source: "https://artificialanalysis.ai",
      attribution: "Data: Artificial Analysis (artificialanalysis.ai)",
      generatedAt: "2026-11-09T00:00:00.000Z",
      models: [{ slug: "kimi-k3-0", base: "kimi-k3", name: "Kimi K3", creator: "x", releaseDate: "2026-10-01", effort: null, intelligence: null, costPerTask: null, priceIn: 1.5, priceOut: 6, intelligenceEstimated: null, checkedAt: null }],
    }));
    fs.mkdirSync(path.join(home, "logs"));
    // No usage-hourly.jsonl yet, so the whole request log is replayed: one million input and one million output tokens.
    fs.writeFileSync(path.join(home, "logs", "requests.jsonl"), JSON.stringify(record("r1", { provider: "opencode-go", target: "kimi-k3", usage: { input: 1_000_000, cached: 0, output: 1_000_000 } })) + "\n");
    const requests = openRequestLog(home);
    const total = requests.usage(0, Date.now() + 3_600_000).total;
    assert.equal(total.costUsd, 7.5);
    assert.equal(total.unpricedRequests, 0);
  } finally {
    setAaPriceDataset(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
