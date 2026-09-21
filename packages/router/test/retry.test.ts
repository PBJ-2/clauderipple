// A relay's hiccup must be absorbed inside the turn rather than handed to the user as an error they
// retry by hand (2026-09-21: OpenCode Go answered 403 `Upstream request failed` for DeepSeek, and
// every manual retry worked). These pin the two rules that keep that retry safe: only a *transient*
// failure is retried, and a request the provider will refuse identically is not re-sent at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { fetchWithRetry } from "../src/providers/retry.ts";

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
