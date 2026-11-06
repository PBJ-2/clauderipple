// A relay's hiccup must be absorbed inside the turn rather than handed to the user as an error they
// retry by hand (2026-09-21: OpenCode Go answered 403 `Upstream request failed` for DeepSeek, and
// every manual retry worked). These pin the two rules that keep that retry safe: only a *transient*
// failure is retried, and a request the provider will refuse identically is not re-sent at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { allowLongSilences, fetchWithRetry } from "../src/providers/retry.ts";

/** A server that answers from a script, recording how many times it was asked. */
async function server(replies: { status: number; body?: string }[]): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let n = 0;
  const s = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const r = replies[Math.min(n, replies.length - 1)]!;
      n++;
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, calls: () => n, close: () => new Promise<void>((r) => s.close(() => r())) };
}

const noop = (): void => {};
const opts = { log: noop, attempts: 4 };

test("a relay reporting a broken upstream is retried, and the turn is answered", async () => {
  const relay = JSON.stringify({ error: { type: "server_error", message: "Error from provider (Console Go): Upstream request failed: [server_error] Upstream response was not valid JSON" } });
  // Two refusals of this shape, then the answer the third ask was always going to get.
  const s = await server([{ status: 403, body: relay }, { status: 403, body: relay }, { status: 200 }]);
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, opts);
    assert.equal(res.status, 200);
    assert.equal(s.calls(), 3, "asked again until it answered");
  } finally { await s.close(); }
});

test("regression: a relay's 402 endpoint failure is retried within the turn", async () => {
  const relay = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable" } });
  const s = await server([{ status: 402, body: relay }, { status: 200, body: '{"answer":"recovered"}' }]);
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, opts);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"answer":"recovered"}');
    assert.equal(s.calls(), 2);
  } finally { await s.close(); }
});

test("a 5xx is retried, a connect failure is retried", async () => {
  const s = await server([{ status: 503 }, { status: 500 }, { status: 200 }]);
  try {
    assert.equal((await fetchWithRetry(s.url, { method: "POST", body: "{}" }, opts)).status, 200);
    assert.equal(s.calls(), 3);
  } finally { await s.close(); }

  // Nothing listening: a refused connection is transient, so it is worth one more try.
  const dead = await server([{ status: 200 }]);
  const url = dead.url;
  await dead.close();
  await assert.rejects(() => fetchWithRetry(url, { method: "POST", body: "{}" }, { log: noop, attempts: 2 }));
});

test("regression: a relay's 429 endpoint failure is retried within the turn", async () => {
  const relay = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 5 s)" } });
  const s = await server([{ status: 429, body: relay }, { status: 200, body: '{"answer":"recovered"}' }]);
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, opts);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"answer":"recovered"}');
    assert.equal(s.calls(), 2, "the relay's own 429 did not end the turn");
  } finally { await s.close(); }
});

test("a 401, 429 or 400 is not retried — the same provider refuses the identical request every time", async () => {
  for (const status of [401, 429, 400]) {
    const s = await server([{ status, body: JSON.stringify({ error: { message: "no" } }) }]);
    try {
      const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, opts);
      assert.equal(res.status, status);
      assert.equal(s.calls(), 1, `a ${status} is asked once, not until the ceiling`);
    } finally { await s.close(); }
  }
});

test("a 403 about the credential is not retried, and the vendor's body survives for the caller", async () => {
  const s = await server([{ status: 403, body: JSON.stringify({ error: { message: "Invalid API key" } }) }]);
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, opts);
    // A policy 403 is not about the credential, but it is also not transient: asking again changes
    // nothing. Either way the caller still has the body to show.
    assert.equal(res.status, 403);
    assert.equal(s.calls(), 1);
    assert.match(await res.text(), /Invalid API key/, "cloning for the verdict left the body readable");
  } finally { await s.close(); }
});

test("an exhausted ceiling answers with the provider's own refusal, not a synthetic error", async () => {
  const relay = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed" } });
  const s = await server([{ status: 403, body: relay }]);
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, { log: noop, attempts: 3 });
    assert.equal(res.status, 403);
    assert.equal(s.calls(), 3, "tried exactly the ceiling");
    assert.match(await res.text(), /Upstream request failed/);
  } finally { await s.close(); }
});

test("an abort is not retried — the client is gone, not the provider", async () => {
  const s = await server([{ status: 503 }]);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => fetchWithRetry(s.url, { method: "POST", body: "{}", signal: controller.signal }, opts),
      "an aborted turn must not be asked again",
    );
  } finally { await s.close(); }
});

test("an abort during backoff stops before the next attempt", async () => {
  const s = await server([{ status: 503 }]);
  const controller = new AbortController();
  try {
    await assert.rejects(
      () => fetchWithRetry(
        s.url,
        { method: "POST", body: "{}", signal: controller.signal },
        { attempts: 4, log: () => controller.abort() },
      ),
      { name: "AbortError" },
    );
    assert.equal(s.calls(), 1, "the abandoned turn is not kept alive through backoff");
  } finally { await s.close(); }
});

test("stopOn hands back a 5xx it names at once, with its body intact; other 5xx keep the ladder", async () => {
  const marked = JSON.stringify({ error: { code: 503, details: [{ reason: "MARKED" }] } });
  const stopOn = (status: number, text: string): boolean => status === 503 && text.includes("MARKED");
  const s = await server([{ status: 503, body: marked }, { status: 200 }]);
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", body: "{}" }, { ...opts, stopOn });
    assert.equal(res.status, 503);
    assert.equal(await res.text(), marked, "the caller still reads the body the hook read");
    assert.equal(s.calls(), 1);
  } finally { await s.close(); }
  const plain = await server([{ status: 503, body: "{}" }, { status: 200 }]);
  try {
    const res = await fetchWithRetry(plain.url, { method: "POST", body: "{}" }, { ...opts, stopOn });
    assert.equal(res.status, 200);
    assert.equal(plain.calls(), 2, "an unmarked 503 is retried exactly as without the hook");
  } finally { await plain.close(); }
});

test("allowLongSilences sets how long the global fetch waits between body bytes", async () => {
  // A stream that says one event and then nothing for 1.5s: a reasoning model thinking.
  const quiet = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: response.created\ndata: {}\n\n");
    setTimeout(() => res.end("event: response.completed\ndata: {}\n\n"), 1_500);
  });
  await new Promise<void>((resolve) => quiet.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(quiet.address() as { port: number }).port}/`;
  try {
    allowLongSilences(500);
    await assert.rejects(async () => { await (await fetch(url)).text(); }, (e: Error & { cause?: { code?: string } }) => e.cause?.code === "UND_ERR_BODY_TIMEOUT");
    allowLongSilences(5_000);
    assert.match(await (await fetch(url)).text(), /response\.completed/);
  } finally {
    allowLongSilences();
    await new Promise<void>((resolve) => quiet.close(() => resolve()));
  }
});
