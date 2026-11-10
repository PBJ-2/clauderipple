// Codex's own GPT traffic through the ingress: passed to the ChatGPT backend byte for byte, on an
// account from the pool, moving to the next account when one runs out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { OpenAiIngress } from "../src/ingress/server.ts";
import { ChatGptAdapter } from "../src/providers/chatgpt/index.ts";
import { saveChatGptAccount } from "../src/providers/chatgpt/accounts.ts";
import { CredentialPool } from "../src/pool.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import { DEFAULTS, type Config } from "../src/config.ts";

process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-gpt-codex-"));
const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };
const log = new Logger(null, 1e9, 0, false);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-gpt-"));
const requests = new RequestLog(path.join(home, "requests.jsonl"));

type Hit = { path: string; method: string; headers: http.IncomingHttpHeaders; body: string; raw: Buffer };
const hits: Hit[] = [];
const behaviour = new Map<string, { status: number; headers?: Record<string, string>; body?: string; hold?: boolean }>();
/** Answers left open mid-stream, for a turn the client drops before it ends. */
const held: http.ServerResponse[] = [];
const answer = [
  `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n`,
  `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 5 } } })}\n\n`,
].join("");
let issued = 0;

const backend = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    hits.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers, body: raw.toString("utf8"), raw });
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const planned = behaviour.get(token);
    if (planned?.hold) {
      held.push(res);
      res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": `ts-${token}-held` }).write(answer.slice(0, 60));
      return;
    }
    if (planned && planned.status !== 200) {
      res.writeHead(planned.status, { "content-type": "application/json", ...(planned.headers ?? {}) }).end(planned.body ?? "{}");
      return;
    }
    if ((req.url ?? "").startsWith("/codex/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }));
      return;
    }
    issued += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": `ts-${token}-${issued}`, "x-codex-primary-used-percent": "7", "set-cookie": "nope=1" }).end(answer);
  });
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", () => r()));
const backendUrl = `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`;

const firstAccount = saveChatGptAccount(home, { accessToken: "tok-1", refreshToken: "rt-1", accountId: "ws-1", expiresAt: Date.now() + 3_600_000 });
const secondAccount = saveChatGptAccount(home, { accessToken: "tok-2", refreshToken: "rt-2", accountId: "ws-2", expiresAt: Date.now() + 3_600_000 });
const config: Config = { ...DEFAULTS, providers: { chatgpt: { type: "chatgpt", auth: "own", url: backendUrl } }, listen: { host: "127.0.0.1", port: 0, openaiPort: 0 } };
let adapter = new ChatGptAdapter("chatgpt", config.providers.chatgpt as never, home, log, new CredentialPool());
const ingress = new OpenAiIngress({ config: () => config, log, requests, home, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders, chatgpt: () => adapter });
const port = await ingress.listen();

function codexCall(pathname: string, body: Record<string, unknown> | undefined, session = "sess-1", extra: Record<string, string> = {}, at = port): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const data = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: at,
      path: pathname,
      method: data ? "POST" : "GET",
      headers: {
        authorization: "Bearer caller-token",
        "chatgpt-account-id": "ws-caller",
        originator: "codex_exec",
        session_id: session,
        "x-codex-window-id": `${session}:0`,
        ...extra,
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const turn = { model: "gpt-6-sol", instructions: "x", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], store: false, stream: true, prompt_cache_key: "sess-1" };

test("a GPT turn from Codex goes out unchanged on a pool account, and comes back byte for byte", async () => {
  const res = await codexCall("/v1/responses", turn);
  assert.equal(res.status, 200);
  assert.equal(res.text, answer, "the stream is relayed as is");
  const hit = hits.at(-1)!;
  assert.equal(hit.path, "/codex/responses");
  assert.equal(hit.body, JSON.stringify(turn), "the body is not rewritten");
  assert.equal(hit.headers.authorization, "Bearer tok-1", "the pool's account, not the caller's login");
  assert.equal(hit.headers["chatgpt-account-id"], "ws-1");
  assert.equal(hit.headers.session_id, "sess-1");
  assert.equal(hit.headers["x-codex-window-id"], "sess-1:0");
  assert.equal(hit.headers.originator, "codex_exec");
  assert.equal(res.headers["x-codex-turn-state"], `ts-tok-1-${issued}`);
  assert.equal(res.headers["x-codex-primary-used-percent"], "7");
  assert.equal(res.headers["set-cookie"], undefined, "only protocol headers are relayed");
  const record = requests.list(1)[0]!;
  assert.deepEqual(record.usage, { input: 20, cached: 100, output: 5 });
  assert.equal(record.account, firstAccount.id);
});

test("a Codex turn the client drops mid-stream still names the account that was answering", async () => {
  behaviour.set("tok-1", { status: 200, hold: true });
  const before = requests.list(100).length;
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers: { authorization: "Bearer caller-token", "chatgpt-account-id": "ws-caller", originator: "codex_exec", session_id: "sess-drop", "content-type": "application/json" } }, (res) => {
      res.once("data", () => { req.destroy(); resolve(); });
    });
    req.on("error", (error) => { if (!/socket hang up|aborted/i.test(error.message)) reject(error); });
    req.end(JSON.stringify(turn));
  });
  // The row is written when the server sees the socket close, a moment after the client left.
  for (let i = 0; i < 50 && requests.list(100).length === before; i++) await new Promise((r) => setTimeout(r, 20));
  const record = requests.list(1)[0]!;
  assert.equal(record.ok, false);
  assert.equal(record.status, 499);
  assert.equal(record.note, "client closed");
  assert.equal(record.account, firstAccount.id, "a row cut off mid-stream still names the account that answered");
  behaviour.delete("tok-1");
});

test("account 1 at its limit: Codex's same turn is answered on account 2, no sign-out", async () => {
  behaviour.set("tok-1", { status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "1800", "x-codex-primary-window-minutes": "300" }, body: JSON.stringify({ error: { type: "usage_limit_reached", message: "limit" } }) });
  const before = hits.length;
  const res = await codexCall("/v1/responses", turn, "sess-2", { "x-codex-turn-state": `ts-tok-1-${issued}` });
  assert.equal(res.status, 200);
  const sent = hits.slice(before);
  assert.deepEqual(sent.map((h) => h.headers.authorization), ["Bearer tok-1", "Bearer tok-2"]);
  assert.equal(sent[1]!.headers["x-codex-turn-state"], undefined, "account 1's turn token is not shown to account 2");
  assert.equal(requests.list(1)[0]!.account, secondAccount.id);
  const next = await codexCall("/v1/responses", turn, "sess-3");
  assert.equal(next.status, 200);
  assert.equal(hits.at(-1)!.headers.authorization, "Bearer tok-2", "account 1 rests until its window resets");
});

test("every pool account out: Codex's own login answers instead of a failure", async () => {
  behaviour.set("tok-2", { status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-after-seconds": "1800" }, body: "{}" });
  const res = await codexCall("/v1/responses", turn, "sess-4");
  assert.equal(res.status, 200);
  assert.equal(hits.at(-1)!.headers.authorization, "Bearer caller-token");
  assert.equal(hits.at(-1)!.headers["chatgpt-account-id"], "ws-caller");
  assert.equal(requests.list(1)[0]!.account, undefined, "the caller's workspace id is not a local owner id");
  behaviour.clear();
});

/** Writes the Codex CLI's login as `~/.codex/auth.json` holds it, and returns its access token. */
function writeCodexLogin(email: string, accountId: string): string {
  const jwt = (claims: Record<string, unknown>): string => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
  fs.writeFileSync(path.join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: accessToken, id_token: jwt({ email }), account_id: accountId } }));
  return accessToken;
}

test("a Codex row keeps the name of the borrowed login that answered, after the Codex login is switched", async () => {
  const firstToken = writeCodexLogin("first@example.test", "ws-codex-first");
  // A provider on `auto` with no stored account of its own: the borrowed Codex login is the one that answers.
  const borrowedHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-codex-login-"));
  const borrowing = new ChatGptAdapter("chatgpt", { ...(config.providers.chatgpt as object), auth: "auto" } as never, borrowedHome, log, new CredentialPool());
  const borrowingIngress = new OpenAiIngress({ config: () => config, log, requests, home: borrowedHome, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders, chatgpt: () => borrowing });
  const borrowingPort = await borrowingIngress.listen();
  try {
    const first = await codexCall("/v1/responses", turn, "sess-borrow-1", {}, borrowingPort);
    assert.equal(first.status, 200);
    assert.equal(hits.at(-1)!.headers.authorization, `Bearer ${firstToken}`, "the borrowed login answered");
    const firstRow = requests.list(1)[0]!;
    assert.equal(firstRow.account, "codex");
    assert.equal(firstRow.borrowedLabel, "first@example.test");
    assert.doesNotMatch(JSON.stringify(firstRow), /eyJ/, "no token in the row");

    // The Codex CLI signs in as someone else: the owner id stays `codex`, the row keeps the name it answered as.
    writeCodexLogin("second@example.test", "ws-codex-second");
    const second = await codexCall("/v1/responses", turn, "sess-borrow-2", {}, borrowingPort);
    assert.equal(second.status, 200);
    assert.equal(requests.list(1)[0]!.borrowedLabel, "second@example.test");
    assert.equal(requests.list(100).find((record) => record.id === firstRow.id)?.borrowedLabel, "first@example.test");
  } finally {
    await borrowingIngress.drain(1_000);
    fs.rmSync(borrowedHome, { recursive: true, force: true });
  }
});

test("remote compaction and Codex's catalogue refresh take the same route", async () => {
  adapter = new ChatGptAdapter("chatgpt", config.providers.chatgpt as never, home, log, new CredentialPool());
  const compact = await codexCall("/v1/responses/compact", { model: "gpt-6-sol", input: [] });
  assert.equal(compact.status, 200);
  assert.equal(hits.at(-1)!.path, "/codex/responses/compact");
  const models = await codexCall("/v1/models?client_version=0.160.0", undefined);
  assert.equal(models.status, 200);
  assert.equal(hits.at(-1)!.path, "/codex/models?client_version=0.160.0");
  assert.equal(hits.at(-1)!.method, "GET");
  assert.match(models.text, /gpt-6-sol/);
});

// Codex signed in to ChatGPT sends its body zstd-compressed (measured 2026-09-24); reading it raw
// failed every GPT turn with "Invalid JSON" before the model was even known.
test("a zstd-compressed Codex body is routed by its model and passed on still compressed", async () => {
  const compressed = zlib.zstdCompressSync(Buffer.from(JSON.stringify(turn)));
  const res = await new Promise<{ status: number }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/responses", method: "POST", headers: { authorization: "Bearer caller-token", "chatgpt-account-id": "ws-caller", "content-type": "application/json", "content-encoding": "zstd", "content-length": compressed.length, session_id: "sess-z" } }, (r) => { r.resume(); r.on("end", () => resolve({ status: r.statusCode ?? 0 })); });
    req.on("error", reject);
    req.end(compressed);
  });
  assert.equal(res.status, 200);
  const hit = hits.at(-1)!;
  assert.equal(hit.headers["content-encoding"], "zstd");
  assert.ok(hit.raw.equals(compressed), "the compressed bytes go out as sent");
});

test("a WebSocket attempt is told 426, so Codex falls back to HTTP", async () => {
  const reply = await new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET /v1/responses HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    });
    let text = "";
    socket.on("data", (c: Buffer) => (text += c.toString()));
    socket.on("close", () => resolve(text));
  });
  assert.match(reply, /^HTTP\/1\.1 426/);
});

test("cleanup", async () => {
  for (const res of held) res.destroy();
  await ingress.drain(0);
  backend.close();
});
