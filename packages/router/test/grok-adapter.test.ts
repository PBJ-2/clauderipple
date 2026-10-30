import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GrokAdapter } from "../src/providers/grok/index.ts";
import { GrokAuth, grokAuthPath, type RunCli } from "../src/providers/grok/auth.ts";
import { grokModelsFromListing } from "../src/providers/grok/catalog.ts";
import { Logger } from "../src/log.ts";
import type { OpenAiOutcome } from "../src/providers/openai/index.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { requestKind } from "../src/routing.ts";

const HOUR = 3600_000;
const sse = (records: Record<string, unknown>[]) => records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

/** The proxy as measured 2026-10-08: refuses a token it does not know (401), streams Chat otherwise. */
const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let accepted = new Set(["tok-a"]);
/** When set, an accepted turn is answered 200 with this as an SSE `error` — a proxy echoing a token mid-stream. */
let streamError: string | null = null;
/** Appended to a 401 body, to play a proxy that echoes more than the token it was just sent. */
let refusalEcho = "";
/** When set, a refusal is sent with exactly this body. */
let rawRefusal: string | null = null;
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> });
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!accepted.has(token)) {
      res.writeHead(401, { "content-type": "application/json" }).end(rawRefusal ?? JSON.stringify({ error: `Invalid or expired credentials (token ${token})${refusalEcho}` }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (streamError !== null) {
      res.end(sse([{ error: { message: streamError, code: "invalid_request" } }]));
      return;
    }
    res.end(sse([
      { choices: [{ delta: { role: "assistant", reasoning_content: "Need the weather." }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Seoul"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 1342, prompt_tokens_details: { cached_tokens: 1152 }, completion_tokens: 12 } },
    ]) + "data: [DONE]\n\n");
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const upstreamPort = await listen(upstream);
const log = new Logger(null, 1_000_000, 1, false);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-grok-adapter-"));
fs.mkdirSync(path.join(dir, "bin"));
fs.writeFileSync(path.join(dir, "bin", process.platform === "win32" ? "grok.exe" : "grok"), "#!/bin/sh\n", { mode: 0o755 });

function writeAuth(key: string, expiresAt = Date.now() + 5 * HOUR): void {
  fs.writeFileSync(grokAuthPath(dir), JSON.stringify({ "https://auth.x.ai::u": { key, expires_at: new Date(expiresAt).toISOString(), refresh_token: "r" } }));
  // Distinct mtimes even within one clock tick.
  const t = new Date(Date.now() + seen.length * 1000 + Math.random() * 1000);
  fs.utimesSync(grokAuthPath(dir), t, t);
}

let onRefresh: () => void | Promise<void> = () => {};
const runs: string[][] = [];
const run: RunCli = async (_file, args) => {
  runs.push(args);
  if (args[0] === "--version") return "grok 1.0.46 (2765805b9442) [stable]\n";
  await onRefresh();
  return "";
};
/** Moved forward by a test that needs the once-a-minute forced refresh to be available again. */
let clockSkew = 0;
const auth = new GrokAuth({ home: dir, log, run, env: { PATH: "", HOME: dir }, now: () => Date.now() + clockSkew });
let adapter = new GrokAdapter("grok", {
  type: "grok",
  url: `http://127.0.0.1:${upstreamPort}/v1`,
  models: [{ id: "grok-4.5", effortLevels: ["low", "medium", "high"] }],
}, log, auth);

const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest & { model: string };
    const requestPath = (req.url ?? "/v1/messages").split("?")[0] ?? "/v1/messages";
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, json.model, req.headers["x-effort"] as string | undefined, { kind: requestKind(json, requestPath) }).then((outcome) => { lastOutcome = outcome; });
  });
});
const frontPort = await listen(front);
let lastOutcome: OpenAiOutcome | undefined;
/** The outcome is recorded after the response ends; give the handler its tick. */
async function outcome(): Promise<OpenAiOutcome> {
  for (let i = 0; i < 50 && !lastOutcome; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const out = lastOutcome!;
  lastOutcome = undefined;
  return out;
}

function call(body: unknown, opts: { path?: string; effort?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: frontPort, method: "POST", path: opts.path ?? "/v1/messages",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), ...(opts.effort ? { "x-effort": opts.effort } : {}) },
    }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

const turn = (model: string) => ({
  model,
  max_tokens: 512,
  stream: true,
  system: "You are terse.",
  tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
  messages: [{ role: "user", content: "Weather in Seoul?" }],
});

test("a turn goes out as Chat Completions with the session and routing headers, and tool calls come back as tool_use", async () => {
  writeAuth("tok-a");
  seen.length = 0;
  const res = await call(turn("grok-4.7"), { effort: "xhigh" });
  assert.equal(res.status, 200);
  const sent = seen[0]!;
  assert.equal(sent.path, "/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer tok-a");
  assert.equal(sent.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(sent.headers["x-grok-model-override"], "grok-4.7", "the proxy routes on this header, not the body");
  assert.equal(sent.headers["x-grok-client-version"], "1.0.46");
  assert.equal(sent.body.model, "grok-4.7");
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.reasoning_effort, "xhigh");
  assert.ok(Array.isArray(sent.body.tools));
  assert.match(res.text, /"type":"thinking"/);
  assert.match(res.text, /"type":"tool_use","id":"call-1","name":"get_weather"/);
  assert.match(res.text, /"stop_reason":"tool_use"/);
  assert.match(res.text, /"cache_read_input_tokens":1152/);
});

test("a model's own ladder from the listing clamps the effort it is sent", async () => {
  writeAuth("tok-a");
  seen.length = 0;
  await call(turn("grok-4.5"), { effort: "xhigh" });
  assert.equal(seen[0]!.body.reasoning_effort, "high");
  assert.equal(seen[0]!.headers["x-grok-model-override"], "grok-4.5");
});

test("a token the CLI rotated after we read it is refused once, then the turn is asked again and answered", async () => {
  writeAuth("tok-a");
  await call(turn("grok-4.7")); // the adapter has now read tok-a
  accepted = new Set(["tok-b"]);
  onRefresh = () => writeAuth("tok-b");
  seen.length = 0;
  runs.length = 0;
  const res = await call(turn("grok-4.7"));
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((s) => s.headers.authorization), ["Bearer tok-a", "Bearer tok-b"]);
  assert.deepEqual(runs.filter((r) => r[0] === "models").length, 1, "the CLI refreshed the refused token");
  accepted = new Set(["tok-a"]);
  onRefresh = () => {};
});

test("a session the proxy keeps refusing ends as an authentication error that names grok login and not the token", async () => {
  writeAuth("tok-revoked");
  accepted = new Set();
  seen.length = 0;
  const res = await call(turn("grok-4.7"));
  assert.equal(res.status, 401);
  const body = JSON.parse(res.text) as { error: { type: string; message: string } };
  assert.equal(body.error.type, "authentication_error");
  assert.match(body.error.message, /^Grok: /);
  assert.match(body.error.message, /grok login/);
  assert.doesNotMatch(res.text, /tok-revoked/);
  assert.equal(seen.length, 1, "asked again only when a different token exists");
  accepted = new Set(["tok-a"]);
});

test("a token echoed in a 200 stream's error reaches neither the client nor the request log, streamed or not", async () => {
  writeAuth("tok-a");
  streamError = "session tok-a is not valid for this model";
  for (const stream of [true, false]) {
    lastOutcome = undefined;
    const res = await call({ ...turn("grok-4.7"), stream });
    const note = (await outcome()).note ?? "";
    assert.match(res.text, /not valid for this model/, `stream=${stream}: the error itself still reaches the client`);
    assert.doesNotMatch(res.text, /tok-a/, `stream=${stream}: client`);
    assert.match(note, /not valid for this model/);
    assert.doesNotMatch(note, /tok-a/, `stream=${stream}: request log note`);
  }
  streamError = null;
});

test("after a 401 retry, an error that echoes the first token is redacted as well as one that echoes the second", async () => {
  // Mid-stream: tok-a is refused, the CLI rotates to tok-b, and tok-b's stream fails naming both.
  writeAuth("tok-a");
  accepted = new Set(["tok-b"]);
  onRefresh = () => writeAuth("tok-b");
  streamError = "tok-b replaced tok-a";
  clockSkew += 2 * 60_000;
  lastOutcome = undefined;
  let res = await call(turn("grok-4.7"));
  assert.doesNotMatch(res.text + ((await outcome()).note ?? ""), /tok-[ab]/);
  streamError = null;
  // HTTP error: tok-c is refused, the CLI rotates to tok-d, which is refused naming both.
  writeAuth("tok-c");
  accepted = new Set();
  onRefresh = () => writeAuth("tok-d");
  refusalEcho = "; earlier tok-c";
  clockSkew += 2 * 60_000;
  seen.length = 0;
  res = await call(turn("grok-4.7"));
  assert.equal(res.status, 401);
  assert.deepEqual(seen.map((s) => s.headers.authorization), ["Bearer tok-c", "Bearer tok-d"]);
  assert.doesNotMatch(res.text, /tok-[cd]/);
  refusalEcho = "";
  accepted = new Set(["tok-a"]);
  onRefresh = () => {};
});

test("a refused token the proxy escapes inside its JSON error is still redacted for the client", async () => {
  writeAuth("tok-e");
  accepted = new Set();
  rawRefusal = '{"error":"session \\u0074ok-e was revoked"}';
  const res = await call(turn("grok-4.7"));
  assert.equal(res.status, 401);
  assert.match(res.text, /was revoked/);
  assert.doesNotMatch(res.text, /tok-e/);
  rawRefusal = null;
  accepted = new Set(["tok-a"]);
});

test("a client that leaves while the session is being refreshed cancels the turn: nothing is sent", async () => {
  clockSkew += 2 * 60_000; // past the failure backoff, so the near-expiry token is refreshed
  writeAuth("tok-a", Date.now() + clockSkew + 5 * 60_000);
  let release!: () => void;
  onRefresh = () => new Promise<void>((resolve) => { release = () => { writeAuth("tok-a"); resolve(); }; });
  seen.length = 0;
  runs.length = 0;
  lastOutcome = undefined;
  const raw = JSON.stringify(turn("grok-4.7"));
  const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } });
  req.on("error", () => {});
  req.end(raw);
  for (let i = 0; i < 100 && !runs.some((r) => r[0] === "models"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(runs.some((r) => r[0] === "models"), "the refresh is under way");
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  assert.equal((await outcome()).note, "client closed");
  assert.equal(seen.length, 0, "the cancelled turn spent no quota");
  onRefresh = () => {};
});

test("an Auto mode classifier's system text reaches the upstream exactly as sent", async () => {
  writeAuth("tok-a");
  seen.length = 0;
  const restore = adapter;
  const system = "You are a security monitor for autonomous AI coding agents.\n\nJudge this action.";
  const addendum = "Be brief.";
  const classifier: AnthropicRequest = { model: "claude-haiku-5-5", stream: true, system, messages: [{ role: "user", content: "check" }] };
  const ordinarySystem = "Judge this action.";
  adapter = new GrokAdapter("grok", {
    type: "grok",
    url: `http://127.0.0.1:${upstreamPort}/v1`,
    instructionsAppend: addendum,
    models: [{ id: "grok-4.5", effortLevels: ["low", "medium", "high"] }],
  }, log, auth);

  try {
    const classifierResponse = await call(classifier);
    assert.equal(classifierResponse.status, 200);
    assert.equal((seen.at(-1)!.body.messages as { content: unknown }[])[0]!.content, system);

    const turnResponse = await call({ ...classifier, system: ordinarySystem });
    assert.equal(turnResponse.status, 200);
    assert.equal(
      (seen.at(-1)!.body.messages as { content: unknown }[])[0]!.content,
      `You are claude-haiku-5-5, answering through Claude Code, a terminal-based coding agent.\n\n${ordinarySystem}\n\n${addendum}`,
    );
  } finally {
    adapter = restore;
  }
});

test("with no session nothing is sent, and counting tokens still works", async () => {
  fs.rmSync(grokAuthPath(dir));
  seen.length = 0;
  const res = await call(turn("grok-4.7"));
  assert.equal(res.status, 401);
  assert.match(res.text, /no Grok session/);
  assert.equal(seen.length, 0);
  const count = await call({ model: "grok-4.7", messages: [{ role: "user", content: "hi" }] }, { path: "/v1/messages/count_tokens" });
  assert.equal(count.status, 200);
  assert.match(count.text, /input_tokens/);
});

test("the listing becomes model entries with ascending ladders and nothing that would change the wire", () => {
  const models = grokModelsFromListing({
    object: "list",
    data: [
      { id: "grok-4.7", name: "Grok 4.7", context_window: 256000, api_backend: "responses", supports_reasoning_effort: true,
        reasoning_efforts: [{ id: "xhigh", value: "xhigh" }, { id: "high", value: "high", default: true }, { id: "medium", value: "medium" }, { id: "low", value: "low" }] },
      { id: "grok-4.5", context_window: 256000, supports_reasoning_effort: true, reasoning_efforts: [{ id: "high", value: "high" }, { id: "low", value: "low" }] },
      { id: "plain", supports_reasoning_effort: false },
      { name: "no id" },
    ],
  });
  assert.deepEqual(models, [
    { id: "grok-4.7", name: "Grok 4.7", contextWindow: 256000, effortLevels: ["low", "medium", "high", "xhigh"] },
    { id: "grok-4.5", contextWindow: 256000, effortLevels: ["low", "high"] },
    { id: "plain", effortLevels: [] },
  ]);
});

test.after(() => {
  upstream.close();
  front.close();
});
