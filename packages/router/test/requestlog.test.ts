import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLog, ResponseUsageTap, type RequestRecord } from "../src/requestlog.ts";

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
    const reloaded = new RequestLog(file, 2);
    assert.deepEqual(reloaded.list(10).map((r) => r.id), ["three", "two"]);
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
    log.add(record("old", { at: "2026-09-13T09:00:00.000Z", usage: { input: 999, cached: 0, output: 999 } }));
    const summary = log.summary(Date.parse("2026-09-13T09:59:00.000Z"));
    assert.deepEqual(summary.total, { count: 2, ok: 1, failed: 1, input: 70, cached: 80, output: 9, cacheHitPercent: 53.3, avgMs: 200 });
    assert.deepEqual(summary.providers.chatgpt, { count: 1, ok: 1, failed: 0, input: 20, cached: 80, output: 9, cacheHitPercent: 80, avgMs: 100 });
    assert.deepEqual(summary.providers.moonshot, { count: 1, ok: 0, failed: 1, input: 50, cached: 0, output: 0, cacheHitPercent: 0, avgMs: 300 });
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
