// ChatGPT hosted search answers a search when cfg.webSearch names that provider, or when the search
// is routed to one. Drive the real CONNECT/TLS proxy so interception-before-routing, the routed
// path and the response shape stay covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function decodeHttpResponse(raw: Buffer): { status: number; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  assert.ok(split >= 0, "response has headers");
  const head = raw.subarray(0, split).toString("latin1");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  let body = raw.subarray(split + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < body.length) {
      const lineEnd = body.indexOf("\r\n", offset);
      assert.ok(lineEnd >= 0, "chunk has a size line");
      const length = Number.parseInt(body.subarray(offset, lineEnd).toString("ascii"), 16);
      assert.ok(Number.isFinite(length), "chunk size is hexadecimal");
      if (length === 0) break;
      const start = lineEnd + 2;
      chunks.push(body.subarray(start, start + length));
      offset = start + length + 2;
    }
    body = Buffer.concat(chunks);
  }
  return { status, body: body.toString("utf8") };
}

type SearchReply = {
  message: { content: { type?: string; content?: { url?: string }[] }[]; usage: { server_tool_use: { web_search_requests: number } } };
  seenTool: unknown;
  target: string | undefined;
};

/** One `WebSearch` side request for `model`, through a real proxy whose ChatGPT backend is local. */
async function searchThrough(model: string, cfgFor: (backendUrl: string) => Partial<Config>): Promise<SearchReply> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-websearch-"));
  const ca = createCa({ cn: "clauderipple web-search test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({
    accessToken: "tok_test",
    accountId: "acct_test",
    expiresAt: Date.now() + 3600_000,
    source: "own",
  }));

  let seenTool: unknown;
  const backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown[] };
      seenTool = body.tools?.[0];
      const events = [
        { type: "response.output_text.delta", delta: "Node.js 24 is current." },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", title: "Node.js", url: "https://nodejs.org/en/download" } },
        { type: "response.completed", response: { tool_usage: { web_search: { num_requests: 1 } } } },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as net.AddressInfo).port;
  const proxyPort = await freePort();
  const cfg: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: proxyPort },
    ...cfgFor(`http://127.0.0.1:${backendPort}`),
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    agentDir: path.join(home, "agents"),
  });
  await proxy.listen();

  try {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve());
      socket.once("error", reject);
    });
    const secure = tls.connect({ socket, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Perform a web search for the query: latest Node.js 24 release" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["nodejs.org"] }],
      tool_choice: { type: "auto" },
    });
    const response = await new Promise<Buffer>((resolve, reject) => {
      let received = Buffer.alloc(0);
      let settle: NodeJS.Timeout | undefined;
      secure.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => resolve(received), 50);
      });
      secure.once("error", reject);
      secure.write(
        "POST /v1/messages HTTP/1.1\r\n" +
        "Host: api.anthropic.com\r\n" +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
      );
    });
    secure.destroy();
    const decoded = decodeHttpResponse(response);
    assert.equal(decoded.status, 200);
    return {
      message: JSON.parse(decoded.body) as SearchReply["message"],
      seenTool,
      target: requests.list(10).find((entry) => entry.kind === "messages")?.target,
    };
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertSearched(reply: SearchReply, target: string): void {
  const result = reply.message.content.find((block) => block.type === "web_search_tool_result");
  assert.deepEqual(result?.content, [{ type: "web_search_result", title: "Node.js", url: "https://nodejs.org/en/download" }]);
  assert.equal(reply.message.usage.server_tool_use.web_search_requests, 1);
  assert.deepEqual(reply.seenTool, {
    type: "web_search",
    search_context_size: "low",
    external_web_access: true,
    filters: { allowed_domains: ["nodejs.org"] },
  });
  assert.equal(reply.target, target);
}

test("the proxy serves a configured ChatGPT hosted search before model routing", async () => {
  const reply = await searchThrough("claude-haiku-4-5", (url) => ({
    providers: { chatgpt: { type: "chatgpt", auth: "own", url } },
    webSearch: { provider: "chatgpt", model: "gpt-5.6-terra", maxResults: 3 },
  }));
  assertSearched(reply, "chatgpt/gpt-5.6-terra");
});

// A `smallFast` slot pointed at a ChatGPT model sends every search there. With no `webSearch` set,
// the router refused them all as a provider without server tools (2026-10-07).
test("a search routed to a ChatGPT provider is served by its own search without webSearch", async () => {
  const reply = await searchThrough("gpt-6-luna@low", (url) => ({
    providers: { chatgpt: { type: "chatgpt", auth: "own", url, models: [{ id: "gpt-6-luna" }] } },
  }));
  assertSearched(reply, "chatgpt/gpt-6-luna");
});
