// Claude is the last resort for Claude Code's own side requests (a search, a page read, a session
// title). When the configured non-Claude provider is spent, they go to a usable native Claude
// provider on Claude Code's small model instead of being refused or sent to the spent provider.
// Drives the real CONNECT/TLS proxy against a local ChatGPT backend and a local Anthropic upstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { CLAUDE_SMALL_MODEL } from "../src/targets.ts";
import { createCa, createLeaf } from "../src/x509.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };

const SEARCH_BODY = {
  model: "gpt-6-luna",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Perform a web search for the query: latest Node.js 24 release" }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["nodejs.org"] }],
  tool_choice: { type: "auto" },
};
const FETCH_PROMPT = "\nWeb page content:\n---\nNode.js 24 is current.\n---\n\nWhich release is current?\n\nProvide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.\n";
const FETCH_BODY = {
  model: "gpt-6-luna",
  max_tokens: 8192,
  system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
  messages: [{ role: "user", content: [{ type: "text", text: FETCH_PROMPT }] }],
  tools: [],
  output_config: { effort: "high" },
  metadata: { user_id: "fetch-test" },
};
const TITLE_BODY = {
  model: "gpt-6-luna",
  max_tokens: 64,
  system: "Generate a concise, sentence-case title for this conversation.",
  messages: [{ role: "user", content: "Fix the flaky login test" }],
};

type Options = {
  /** The ChatGPT account is signed in. Without it the provider has nothing usable. */
  chatgptSignedIn?: boolean;
  /** A Claude subscription account is stored, so the native pool can answer. */
  claude?: boolean;
  webSearch?: boolean;
  smallFast?: boolean;
};

async function rig(options: Options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-last-resort-"));
  const ca = createCa({ cn: "claude last resort test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  if (options.chatgptSignedIn) {
    fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({ accessToken: "tok_test", accountId: "acct_test", expiresAt: Date.now() + 3_600_000, source: "own" }));
  }
  if (options.claude) {
    saveClaudeOAuthAccount(home, { accessToken: "stored-token", refreshToken: "stored-refresh", expiresAt: Date.now() + 3_600_000, accountId: "stored-upstream-uuid", email: "stored@example.test" });
  }

  const chatgptCalls: string[] = [];
  const chatgpt = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      chatgptCalls.push(req.url ?? "");
      // The weekly quota is spent: every call, search or turn, is refused the way the backend does.
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached" } }));
    });
  });
  const claudeSeen: { authorization?: string; body: Record<string, unknown> }[] = [];
  const claude = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      claudeSeen.push({ ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}), body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "msg_claude", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn",
        content: [{ type: "text", text: "Claude answered" }], usage: { input_tokens: 5, output_tokens: 2 },
      }));
    });
  });
  const probe = net.createServer();
  await Promise.all([chatgpt, claude, probe].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port },
    providers: {
      chatgpt: { type: "chatgpt", auth: "own", url: `http://127.0.0.1:${(chatgpt.address() as net.AddressInfo).port}`, models: [{ id: "gpt-6-luna" }] },
      anthropic: { type: "anthropic", auth: "claude-code", accountPool: true },
    },
    routes: {},
    direct: [],
    aliases: {},
    ...(options.webSearch ? { webSearch: { provider: "chatgpt", model: "gpt-6-luna" } } : {}),
    cli: { ...DEFAULTS.cli, ...(options.smallFast ? { models: { smallFast: "gpt-6-luna" } } : {}) },
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) });
  const proxy = new Proxy({
    config: () => cfg,
    home,
    requests,
    claudeCodeCredentialReaders: noClaudeCodeCredentialReaders,
    agentDir: path.join(home, "agents"),
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    upstreamPort: (claude.address() as net.AddressInfo).port,
    upstreamAgent: agent,
  });
  await proxy.listen();

  async function send(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; text: string; record: RequestRecord | undefined }> {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    const raw = JSON.stringify(body);
    const result = new Promise<string>((resolve, reject) => {
      let text = "";
      secure.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      secure.once("end", () => resolve(text));
      secure.once("close", () => resolve(text));
      secure.once("error", reject);
      secure.setTimeout(15_000, () => { secure.destroy(); reject(new Error("local proxy response timed out")); });
    });
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nauthorization: Bearer app-login\r\ncontent-type: application/json\r\n${extra}content-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`);
    const text = await result;
    secure.destroy();
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0);
    // The record is written when the request finishes, which can trail the last byte by a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { status, text, record: requests.list(10).find((entry) => entry.kind === "messages") };
  }

  return {
    cfg, chatgptCalls, claudeSeen, requests, send,
    stop: async () => {
      proxy.close();
      agent.destroy();
      await Promise.all([chatgpt, claude].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a search whose backend answers 429 and whose route cannot search goes to Claude's small model", async () => {
  const r = await rig({ chatgptSignedIn: true, claude: true, webSearch: true });
  try {
    const { status, record } = await r.send(SEARCH_BODY);
    assert.equal(status, 200);
    assert.ok(r.chatgptCalls.length >= 1, "the configured backend was tried first");
    assert.equal(r.claudeSeen.length, 1, "the search reached the Anthropic upstream once");
    const seen = r.claudeSeen[0]!;
    assert.equal(seen.body.model, CLAUDE_SMALL_MODEL);
    assert.equal(seen.authorization, "Bearer stored-token", "the stored Claude account answered");
    assert.deepEqual(seen.body.tools, SEARCH_BODY.tools, "the web_search tool is kept as sent");
    assert.deepEqual(seen.body.messages, SEARCH_BODY.messages);
    assert.equal(record?.provider, "anthropic");
    assert.equal(record?.target, CLAUDE_SMALL_MODEL);
    assert.equal(record?.purpose, "web-search");
    assert.match(record?.note ?? "", /fallback to Claude \(chatgpt failed\)/);
    assert.equal(record?.refusal, undefined);
  } finally { await r.stop(); }
});

test("with no usable Claude the same search is refused as before, with no invented result", async () => {
  const r = await rig({ chatgptSignedIn: true, claude: false, webSearch: true });
  try {
    const { status, text, record } = await r.send(SEARCH_BODY);
    assert.equal(status, 200);
    assert.match(text, /web_search_tool_result_error/);
    assert.match(text, /"web_search_requests":0/);
    assert.equal(r.claudeSeen.length, 0, "nothing was sent to Anthropic");
    assert.equal(record?.refusal, "web-search-unsupported");
    assert.match(record?.note ?? "", /web search refused: chatgpt runs no server tools/);
  } finally { await r.stop(); }
});

test("a configured backend whose provider is already unusable is not called", async () => {
  // No ChatGPT sign-in: the provider has nothing usable, so asking it would only fail again.
  const r = await rig({ chatgptSignedIn: false, claude: true, webSearch: true });
  try {
    const { status, record } = await r.send(SEARCH_BODY);
    assert.equal(status, 200);
    assert.deepEqual(r.chatgptCalls, [], "the spent backend was not called");
    assert.equal(r.claudeSeen.length, 1);
    assert.equal(r.claudeSeen[0]!.body.model, CLAUDE_SMALL_MODEL);
    assert.match(record?.note ?? "", /fallback to Claude \(chatgpt unusable\)/);
  } finally { await r.stop(); }
});

test("a smallFast title request goes to Claude when its provider is unusable, a subagent's does not", async () => {
  const r = await rig({ chatgptSignedIn: false, claude: true, smallFast: true });
  try {
    const title = await r.send(TITLE_BODY, { "x-claude-code-request-class": "auxiliary" });
    assert.equal(title.status, 200);
    assert.match(title.text, /Claude answered/);
    assert.equal(r.claudeSeen.length, 1);
    assert.equal(r.claudeSeen[0]!.body.model, CLAUDE_SMALL_MODEL);
    assert.equal(r.claudeSeen[0]!.body.output_config, undefined, "the primary's effort did not follow it");
    assert.match(title.record?.note ?? "", /fallback to Claude \(chatgpt unusable\)/);
    assert.equal(title.record?.provider, "anthropic");

    // A subagent on the same model keeps its route (and its failure): it is not a side request.
    const worker = await r.send(TITLE_BODY, { "x-claude-code-request-class": "subagent", "x-claude-code-agent-id": "agent-1" });
    assert.notEqual(worker.status, 200);
    // Neither is a main-session turn on that model, even one that looks like a title request.
    const main = await r.send({ ...TITLE_BODY, tools: [{ name: "Read", input_schema: { type: "object" } }] }, { "x-claude-code-request-class": "main" });
    assert.notEqual(main.status, 200);
    assert.equal(r.claudeSeen.length, 1, "only the title request reached Claude");
  } finally { await r.stop(); }
});

test("a smallFast request stays on its provider while that provider is usable", async () => {
  const r = await rig({ chatgptSignedIn: true, claude: true, smallFast: true });
  try {
    await r.send(TITLE_BODY, { "x-claude-code-request-class": "auxiliary" });
    assert.equal(r.claudeSeen.length, 0, "the primary was usable, so Claude was not used");
    assert.equal(r.chatgptCalls.length >= 1, true);
  } finally { await r.stop(); }
});

test("a page read whose configured provider is unusable goes to Claude instead of the same provider", async () => {
  const r = await rig({ chatgptSignedIn: false, claude: true, webSearch: true, smallFast: true });
  try {
    const { status, text, record } = await r.send(FETCH_BODY);
    assert.equal(status, 200);
    assert.match(text, /Claude answered/);
    assert.deepEqual(r.chatgptCalls, []);
    assert.equal(r.claudeSeen.length, 1);
    assert.equal(r.claudeSeen[0]!.body.model, CLAUDE_SMALL_MODEL);
    assert.equal((r.claudeSeen[0]!.body.output_config as { effort?: string } | undefined)?.effort, undefined);
    assert.equal(record?.purpose, "web-fetch");
    assert.match(record?.note ?? "", /fallback to Claude \(chatgpt unusable\)/);
  } finally { await r.stop(); }
});
