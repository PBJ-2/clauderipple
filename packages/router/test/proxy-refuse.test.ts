// A non-Claude model this router cannot route is refused by name, not forwarded. Forwarding it to
// Anthropic answers 404 and reads as "the model vanished" (2026-09-20: thirty of them). A native
// `claude-*` id is the opposite case — it is deliberately unrouted and must keep passing through
// (§5). This drives the real proxy, the way Claude Code reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const PROVIDERS: Config["providers"] = {
  chatgpt: { type: "chatgpt", models: [{ id: "gpt-5.6-terra" }] },
  "opencode-go": { type: "openai-compatible", url: "http://127.0.0.1:8788", wire: "chat", models: [{ id: "deepseek-v4-pro" }] },
  deepseek: { type: "anthropic-compatible", url: "http://127.0.0.1:8789", models: [{ id: "deepseek-v4-pro" }] },
  anthropic: { type: "anthropic", auth: "claude-code", models: [{ id: "claude-opus-5" }] },
};

type Rig = { send: (model: string, path?: string) => Promise<{ status: number; body: string }>; records: () => RequestRecord[]; stop: () => void };

async function rig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-refuse-"));
  const ca = createCa({ cn: "clauderipple test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const proxyPort = await freePort();
  const cfg: Config = { ...DEFAULTS, listen: { host: "127.0.0.1", port: proxyPort }, providers: PROVIDERS, routes: {}, direct: [], aliases: {} };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    agentDir: path.join(home, "agents"), // empty: no derived aliases in play here
  });
  await proxy.listen();

  const send = async (model: string, pathName = "/v1/messages"): Promise<{ status: number; body: string }> => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    secure.write(
      `POST ${pathName} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const first = await new Promise<Buffer>((r) => secure.once("data", (d: Buffer) => setTimeout(() => r(d), 60)));
    secure.destroy();
    const text = first.toString("latin1");
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
    const split = text.indexOf("\r\n\r\n");
    return { status, body: split >= 0 ? text.slice(split + 4) : "" };
  };

  return {
    send,
    records: () => requests.list(20),
    stop: () => { proxy.close(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test("an unroutable non-claude model is refused 400 with the reason, not sent upstream", async () => {
  const r = await rig();
  try {
    const { status, body } = await r.send("some-model-nobody-has");
    assert.equal(status, 400, "refused, not forwarded");
    assert.equal((JSON.parse(body) as { error: { message: string } }).error.message, 'ClaudeRipple: no provider declares "some-model-nobody-has"');
    const rec = r.records().find((x) => x.kind === "messages");
    assert.ok(rec, "logged");
    assert.equal(rec.ok, false, "counted as a failure, not a success");
    assert.match(rec.note ?? "", /ClaudeRipple: no provider declares/);
  } finally {
    r.stop();
  }
});

test("an ambiguous model is refused 400 and names both providers", async () => {
  const r = await rig();
  try {
    const { status, body } = await r.send("deepseek-v4-pro");
    assert.equal(status, 400);
    assert.match((JSON.parse(body) as { error: { message: string } }).error.message, /declared by two providers \(opencode-go, deepseek\)/);
  } finally {
    r.stop();
  }
});

test("count_tokens on an unroutable non-claude model is refused the same way", async () => {
  const r = await rig();
  try {
    const { status, body } = await r.send("some-model-nobody-has", "/v1/messages/count_tokens");
    assert.equal(status, 400);
    assert.match((JSON.parse(body) as { error: { message: string } }).error.message, /ClaudeRipple: no provider declares/);
  } finally {
    r.stop();
  }
});

test("a native claude-* model is never refused: it passes through to Anthropic", async () => {
  const r = await rig();
  try {
    // Routed to the real upstream. Whatever Anthropic answers, it must not be our refusal — that is
    // what "passes through" means, and it holds whether the network is up (401/404) or not (502).
    const { body } = await r.send("claude-opus-5");
    assert.doesNotMatch(body, /ClaudeRipple:/, "not refused by us");
  } finally {
    r.stop();
  }
});
