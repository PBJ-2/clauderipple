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
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const HOUR = 3600_000;
const sse = (records: Record<string, unknown>[]) => records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

/** The proxy as measured 2026-10-08: refuses a token it does not know (401), streams Chat otherwise. */
const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let accepted = new Set(["tok-a"]);
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> });
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!accepted.has(token)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: `Invalid or expired credentials (token ${token})` }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
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

let onRefresh: () => void = () => {};
const runs: string[][] = [];
const run: RunCli = async (_file, args) => {
  runs.push(args);
  if (args[0] === "--version") return "grok 1.0.46 (2765805b9442) [stable]\n";
  onRefresh();
  return "";
};
const auth = new GrokAuth({ home: dir, log, run, env: { PATH: "", HOME: dir } });
const adapter = new GrokAdapter("grok", {
  type: "grok",
  url: `http://127.0.0.1:${upstreamPort}/v1`,
  models: [{ id: "grok-4.5", effortLevels: ["low", "medium", "high"] }],
}, log, auth);

const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest & { model: string };
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, json.model, req.headers["x-effort"] as string | undefined);
  });
});
const frontPort = await listen(front);

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
