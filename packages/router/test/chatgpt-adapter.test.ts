// End-to-end through the adapter with a fake Codex backend: verifies headers, the request we
// send, SSE parsing over real HTTP, streaming translation, non-streaming assembly and error mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ChatGptAdapter, rateLimitsFromHeaders, rateLimitsFromUsage } from "../src/providers/chatgpt/index.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-gpt-"));
fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "tok_test", accountId: "acct_test", expiresAt: Date.now() + 3600_000, source: "own" }));

type Seen = { headers: http.IncomingHttpHeaders; body: Record<string, unknown>; path: string };
const seen: Seen[] = [];
let mode: "stream" | "search" | "error429" | "sse-error" | "cut-off" = "stream";
// Active quota lookup (GET /wham/usage): its own mode so it can be exercised independently.
let usageMode: "ok" | "unauthorized" | "no-window" = "ok";
let usageHits = 0;
const usageAuth: string[] = [];
let usageDelayMs = 0;
let turnStates = 0;
const usageBody = {
  plan_type: "prolite",
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 559014, reset_at: 1790432598 },
    secondary_window: null,
  },
};

const sse = (evs: Record<string, unknown>[]): string => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const happy = [
  { type: "codex.rate_limits", plan_type: "prolite", rate_limits: { primary: { used_percent: 42 } } },
  { type: "response.created", response: { id: "resp_x" } },
  { type: "response.output_item.added", item: { type: "message", id: "m1" } },
  { type: "response.output_text.delta", delta: "Hi", item_id: "m1" },
  { type: "response.output_item.done", item: { type: "message", id: "m1" } },
  { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "Read", arguments: "" } },
  { type: "response.function_call_arguments.delta", delta: '{"file_path":"a"}', item_id: "fc1" },
  { type: "response.function_call_arguments.done", arguments: '{"file_path":"a"}', item_id: "fc1" },
  { type: "response.output_item.done", item: { type: "function_call", id: "fc1" } },
  { type: "response.completed", response: { id: "resp_x", usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 450 }, output_tokens: 7 } } },
];

const backend = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if ((req.url ?? "").split("?")[0] === "/wham/usage") {
      usageHits += 1;
      usageAuth.push(String(req.headers.authorization ?? ""));
      const respond = (): void => {
        if (usageMode === "unauthorized") {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ detail: "unauthorized" }));
        } else if (usageMode === "no-window") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ plan_type: "prolite", rate_limit: { primary_window: null } }));
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(usageBody));
        }
      };
      if (usageDelayMs > 0) setTimeout(respond, usageDelayMs);
      else respond();
      return;
    }
    seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, path: req.url ?? "" });
    if (mode === "search") {
      res.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "41" });
      res.end(sse([
        { type: "response.output_item.added", item: { id: "ws_1", type: "web_search_call", status: "in_progress" } },
        { type: "response.web_search_call.completed", item_id: "ws_1" },
        { type: "response.output_text.delta", delta: "Node 24.21.0 is current." },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", title: "Node.js downloads", url: "https://nodejs.org/en/download/current" } },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", title: "duplicate", url: "https://nodejs.org/en/download/current" } },
        { type: "response.completed", response: { tool_usage: { web_search: { num_requests: 1 } }, usage: { input_tokens: 100, output_tokens: 10 } } },
      ]));
      return;
    }
    if (mode === "error429") {
      res
        .writeHead(429, {
          "content-type": "application/json",
          "x-codex-plan-type": "prolite",
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-after-seconds": "535755",
          "x-codex-secondary-used-percent": "0",
          "x-codex-secondary-window-minutes": "0",
        })
        .end(JSON.stringify({ error: { message: "The usage limit has been reached", type: "usage_limit_reached" } }));
      return;
    }
    // Every real answer carries the backend's opaque turn token; count them so a test can tell
    // which one the adapter echoed.
    turnStates += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": `ts-${turnStates}` });
    if (mode === "sse-error") {
      res.end(sse([{ type: "response.created", response: {} }, { type: "error", error: { code: "server_is_overloaded", message: "overloaded" } }]));
      return;
    }
    if (mode === "cut-off") {
      res.end(sse([{ type: "response.created", response: {} }, { type: "response.output_text.delta", delta: "Hal" }]));
      return;
    }
    const body = sse(happy);
    // deliver in awkward chunk boundaries to exercise the parser
    let i = 0;
    const step = (): void => {
      if (i >= body.length) return void res.end();
      const n = 37 + ((i * 7) % 50);
      res.write(body.slice(i, i + n));
      i += n;
      setTimeout(step, 1);
    };
    step();
  });
});

const log = new Logger(null, 1e9, 0, false);
let adapter: ChatGptAdapter;
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest;
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, "gpt-5.6-terra", "high");
  });
});

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as { port: number }).port;
}

const backendPort = await listen(backend);
const frontPort = await listen(front);
adapter = new ChatGptAdapter("chatgpt", { type: "chatgpt", auth: "own", url: `http://127.0.0.1:${backendPort}`, instructionsAppend: "Be brief." }, home, log);

function call(body: unknown, p = "/v1/messages"): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path: p, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const request: AnthropicRequest = { model: "claude-opus-4-6", stream: true, system: "sys", messages: [{ role: "user", content: "read a" }], tools: [{ name: "Read", input_schema: { type: "object" } }] };

test("streaming: headers, request body, and translated Anthropic SSE", async () => {
  mode = "stream";
  const r = await call(request);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/event-stream");
  const s = seen.at(-1)!;
  assert.equal(s.path, "/codex/responses");
  assert.equal(s.headers.authorization, "Bearer tok_test");
  assert.equal(s.headers["chatgpt-account-id"], "acct_test");
  assert.equal(s.headers["openai-beta"], "responses=experimental");
  assert.equal(s.headers.originator, "codex_cli_rs");
  // The conversation's identity rides in the headers the Codex CLI uses; the backend keys the
  // prompt cache on it (2026-09-20). All four name the same conversation as the body does.
  assert.equal(s.headers["session-id"], s.body.prompt_cache_key);
  assert.equal(s.headers["thread-id"], s.body.prompt_cache_key);
  assert.equal(s.headers["x-client-request-id"], s.body.prompt_cache_key);
  assert.equal(s.headers["x-codex-window-id"], `${s.body.prompt_cache_key}:0`);
  assert.equal((s.body.client_metadata as { session_id: string }).session_id, s.body.prompt_cache_key);
  assert.equal(s.body.model, "gpt-5.6-terra");
  assert.equal(s.body.stream, true);
  assert.equal(s.body.store, false);
  assert.ok(String(s.body.instructions).endsWith("Be brief."));
  assert.deepEqual(s.body.reasoning, { effort: "high", summary: "auto" });
  const events = r.text.split("\n\n").filter(Boolean).map((f) => f.split("\n")[0]!.replace("event: ", ""));
  assert.equal(events[0], "message_start");
  assert.deepEqual(events.slice(-2), ["message_delta", "message_stop"]);
  assert.ok(r.text.includes('"text_delta","text":"Hi"'));
  assert.ok(r.text.includes('"partial_json":"{\\"file_path\\":\\"a\\"}"'));
  assert.ok(r.text.includes('"cache_read_input_tokens":450'));
  assert.equal(adapter.lastRateLimits?.plan_type, "prolite");
});

test("hosted web search sends the measured Responses tool and extracts cited results", async () => {
  mode = "search";
  const outcome = await adapter.webSearch("gpt-5.6-terra", 5).search({
    query: "latest Node.js 24 release",
    allowedDomains: ["nodejs.org"],
  });
  const s = seen.at(-1)!;
  assert.equal(s.path, "/codex/responses");
  assert.equal(s.headers.authorization, "Bearer tok_test");
  assert.equal(s.body.tool_choice, "required");
  assert.deepEqual(s.body.tools, [{
    type: "web_search",
    search_context_size: "low",
    external_web_access: true,
    filters: { allowed_domains: ["nodejs.org"] },
  }]);
  assert.deepEqual(outcome.hits, [{ title: "Node.js downloads", url: "https://nodejs.org/en/download/current" }]);
  assert.equal(outcome.text, "Node 24.21.0 is current.");
});

test("hosted web search refuses a domain exclusion it cannot enforce", async () => {
  const before = seen.length;
  await assert.rejects(
    () => adapter.webSearch("gpt-5.6-terra").search({ query: "x", blockedDomains: ["example.com"] }),
    /does not support blocked_domains/,
  );
  assert.equal(seen.length, before, "nothing sent upstream");
});

test("non-streaming: assembled message", async () => {
  mode = "stream";
  const r = await call({ ...request, stream: false });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text) as { content: { type: string }[]; stop_reason: string; usage: { input_tokens: number } };
  assert.deepEqual(j.content.map((c) => c.type), ["text", "tool_use"]);
  assert.equal(j.stop_reason, "tool_use");
  assert.equal(j.usage.input_tokens, 50);
});

test("count_tokens is answered locally", async () => {
  const before = seen.length;
  const r = await call(request, "/v1/messages/count_tokens");
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.text).input_tokens > 0);
  assert.equal(seen.length, before, "no upstream call");
});

test("HTTP 429 upstream → Anthropic rate_limit_error 429", async () => {
  mode = "error429";
  const r = await call(request);
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.text).error.type, "rate_limit_error");
  // quota snapshot comes from x-codex-* headers even on an error response
  const q = adapter.lastRateLimits as { plan_type: string; rate_limits: { primary: Record<string, number>; secondary: unknown } };
  assert.equal(q.plan_type, "prolite");
  assert.equal(q.rate_limits.primary.used_percent, 100);
  assert.equal(q.rate_limits.primary.window_minutes, 10080);
  assert.equal(q.rate_limits.primary.reset_after_seconds, 535755);
  assert.equal(q.rate_limits.secondary, null); // zero-minute window = not a real window
  // The only account is now out until its window resets: the next turn is answered here, without
  // asking the backend again, and says when to come back.
  const before = seen.length;
  const again = await call(request);
  assert.equal(again.status, 429);
  assert.equal(seen.length, before, "a resting account is not sent the turn");
  assert.ok(Number(again.headers["retry-after"]) > 0);
  assert.equal(adapter.accountStatus()[0]?.state, "cooling");
  adapter.clearCooldown("legacy");
});

test("rateLimitsFromHeaders: missing headers → null", () => {
  assert.equal(rateLimitsFromHeaders(new Headers({ "content-type": "text/event-stream" })), null);
});

// The backend closing without response.completed used to be finished as end_turn with what had
// arrived, which the client took as the model's final answer (gpt-6-astra, 12 empty turns).
test("a stream cut off before response.completed → retryable overloaded_error, not end_turn", async () => {
  mode = "cut-off";
  const streamed = await call(request);
  assert.match(streamed.text, /"type":"overloaded_error"/);
  assert.doesNotMatch(streamed.text, /message_stop/);
  const whole = await call({ ...request, stream: false });
  assert.equal(whole.status, 529);
  assert.equal(JSON.parse(whole.text).error.type, "overloaded_error");
});

test("SSE error event → streamed Anthropic error event", async () => {
  mode = "sse-error";
  const r = await call(request);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("event: error"));
  assert.ok(r.text.includes("overloaded_error"));
});

test("fetchRateLimits: active lookup maps /wham/usage to the header shape and updates the snapshot", async () => {
  mode = "stream";
  usageMode = "ok";
  usageHits = 0;
  const before = adapter.lastRateLimits;
  const out = await adapter.fetchRateLimits();
  assert.equal(usageHits, 1);
  assert.equal(usageAuth[0], "Bearer tok_test");
  // Same shape as rateLimitsFromHeaders, so /api/status and the GUI read one thing either way.
  assert.equal(out?.type, "codex.rate_limits");
  assert.equal(out?.plan_type, "prolite");
  const rl = out?.rate_limits as { primary: Record<string, number>; secondary: unknown };
  assert.equal(rl.primary.used_percent, 40);
  assert.equal(rl.primary.window_minutes, 10080); // 604800s reported as seconds, surfaced as minutes
  assert.equal(rl.primary.reset_after_seconds, 559014);
  assert.equal(rl.primary.reset_at, 1790432598);
  assert.equal(rl.secondary, null);
  assert.equal(typeof out?.at, "number");
  assert.notEqual(out, before);
  assert.equal(adapter.lastRateLimits, out, "snapshot updated in place");
});

test("fetchRateLimits: 401 → null, snapshot unchanged, and the cached credential is dropped", async () => {
  usageMode = "ok";
  const good = await adapter.fetchRateLimits();
  assert.ok(good);
  usageMode = "unauthorized";
  usageHits = 0;
  const out = await adapter.fetchRateLimits();
  assert.equal(out, null);
  assert.equal(usageHits, 1);
  assert.equal(adapter.lastRateLimits, good, "a failed lookup never clears the last good snapshot");
});

test("fetchRateLimits: a body with no primary window → null", async () => {
  usageMode = "no-window";
  assert.equal(await adapter.fetchRateLimits(), null);
});

test("fetchRateLimits: concurrent callers share one in-flight request", async () => {
  usageMode = "ok";
  usageHits = 0;
  usageDelayMs = 40;
  const [a, b, c] = await Promise.all([adapter.fetchRateLimits(), adapter.fetchRateLimits(), adapter.fetchRateLimits()]);
  usageDelayMs = 0;
  assert.equal(usageHits, 1, "three concurrent lookups → one upstream call");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("rateLimitsFromUsage: secondary counts only with a real window", () => {
  const withSecondary = rateLimitsFromUsage({
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 5, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 1, limit_window_seconds: 0 },
    },
  }) as { rate_limits: { secondary: unknown } };
  assert.equal(withSecondary.rate_limits.secondary, null, "zero-length secondary is not a window");
  assert.equal(rateLimitsFromUsage({ rate_limit: { primary_window: null } }), null);
});

// 2026-09-20: five byte-identical-prefix turns 3–6s apart all came back `cached_tokens: 0` once the
// backend started keying cache affinity on `x-codex-turn-state`. The Codex CLI echoes the token
// from the previous answer; so does the adapter now, per conversation.
test("x-codex-turn-state from the last answer is sent back on the conversation's next turn", async () => {
  mode = "stream";
  // Real conversations carry metadata; without it a one-message request shares the side-request
  // class key (see conversationKey) and would inherit whatever token that class saw last.
  const convA: AnthropicRequest = { ...request, metadata: { user_id: "u-turn-state" }, messages: [{ role: "user", content: "turn-state conversation A" }] };
  const convB: AnthropicRequest = { ...request, metadata: { user_id: "u-turn-state" }, messages: [{ role: "user", content: "turn-state conversation B" }] };
  await call(convA);
  const first = seen.at(-1)!;
  assert.equal(first.headers["x-codex-turn-state"], undefined, "nothing to echo on a conversation's first turn");
  const issued = `ts-${turnStates}`;
  await call({ ...convA, messages: [...convA.messages, { role: "assistant", content: "ok" }, { role: "user", content: "go on" }] });
  assert.equal(seen.at(-1)!.headers["x-codex-turn-state"], issued, "the token the backend issued last time comes back");
  await call(convB);
  assert.equal(seen.at(-1)!.headers["x-codex-turn-state"], undefined, "another conversation does not borrow it");
  const issuedA2 = `ts-${turnStates - 1}`;
  await call({ ...convA, messages: [...convA.messages, { role: "assistant", content: "ok" }, { role: "user", content: "and more" }] });
  assert.equal(seen.at(-1)!.headers["x-codex-turn-state"], issuedA2, "each answer replaces the token for its conversation");
});

test("cleanup", () => {
  backend.close();
  front.close();
});
