import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { DEFAULTS, type Config } from "../src/config.ts";
import { CertStore } from "../src/certs.ts";
import { createCa, createLeaf } from "../src/x509.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import { normalizeSettings } from "../../mod/hooks/settings.ts";
import { workerLadderLine } from "../../mod/hooks/ladder.ts";

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: string | Block[] };
type Body = { model: string; messages: Message[] };
const signed: Block = { type: "thinking", thinking: "fallback reasoning", signature: "opaque-fallback-signature" };
const redacted: Block = { type: "redacted_thinking", data: "opaque-fallback-redaction" };
const text: Block = { type: "text", text: "Working" };
const tool: Block = { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/example" } };
const own = [signed, redacted, text, tool];
const primaryOwn = [{ ...signed, signature: "primary-signature" }, { ...redacted, data: "primary-redaction" }, text];

async function fixture(stream: boolean, run: (f: {
  cfg: Config; seen: Body[]; rawSeen: string[]; proxy: Proxy;
  recover: () => void;
  send: (messages: Message[], model: string) => Promise<{ status: number; raw: string }>;
}) => Promise<void>, native = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-fallback-history-"));
  const ca = createCa({ cn: "isolated fallback test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const seen: Body[] = [];
  const rawSeen: string[] = [];
  let primaryAvailable = false;
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      rawSeen.push(Buffer.concat(chunks).toString());
      const body: Body = JSON.parse(rawSeen.at(-1)!);
      seen.push(body);
      if (body.model === "primary" && !primaryAvailable) {
        res.writeHead(410, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Model primary has been deprecated." } }));
        return;
      }
      const content = body.model === "primary" ? primaryOwn : own;
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_fallback", type: "message", role: "assistant", content, stop_reason: "tool_use" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
      const events = [event({ type: "message_start", message: { id: "msg_fallback", role: "assistant", content: [] } })];
      content.forEach((block, index) => {
        events.push(event({ type: "content_block_start", index, content_block: block.type === "thinking" ? { ...block, signature: "" } : block }));
        if (block.type === "thinking") {
          const signature = String(block.signature);
          for (const fragment of [signature.slice(0, 9), signature.slice(9)]) events.push(event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: fragment } }));
        }
        events.push(event({ type: "content_block_stop", index }));
      });
      events.push(event({ type: "message_stop" }));
      const bytes = Buffer.from(events.join(""));
      // Split JSON fields and UTF-8 transport arbitrarily, not just at event boundaries.
      for (let i = 0; i < bytes.length; i += 17) res.write(bytes.subarray(i, i + 17));
      res.end();
    });
  };
  const upstream = http.createServer(handler);
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  const nativeUpstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, handler);
  nativeUpstream.listen(0, "127.0.0.1"); await once(nativeUpstream, "listening");
  const nativeAgent = new https.Agent({ ca: ca.certPem });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const url = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const cfg: Config = { ...DEFAULTS, upstream: "localhost", listen: { host: "127.0.0.1", port }, routes: {}, direct: [], aliases: { primary: "primary", approved: "approved" }, providers: {
    p: native ? { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "primary" }] }
      : { type: "anthropic-compatible", url, identity: false, models: [{ id: "primary" }], caps: { thinking: "enabled" } },
    q: { type: "anthropic-compatible", url, identity: false, models: [{ id: "approved" }], caps: { thinking: "enabled" } },
  } };
  fs.writeFileSync(path.join(home, "mod-settings.json"), JSON.stringify({ revision: 1, settings: normalizeSettings({ rules: { general: { mode: "ladder", rungs: {
    hard: [{ target: { agent: "primary" }, effort: "high" }, { target: { agent: "approved" }, effort: "low" }],
  } } } }) }));
  if (native) saveClaudeOAuthAccount(home, { accessToken: "test-native-token", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000, accountId: "native-test", email: "native@example.test" });
  const proxy = new Proxy({ config: () => cfg, home, agentDir: home, certs: new CertStore(home), log: new Logger(null, 1e6, 1, false), health: new UpstreamHealth(() => 100, () => {}), requests: new RequestLog(path.join(home, "requests.jsonl")),
    claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
    upstreamPort: (nativeUpstream.address() as net.AddressInfo).port, upstreamAgent: nativeAgent,
  });
  await proxy.listen();
  async function send(messages: Message[], model: string) {
    const socket = net.connect(port, "127.0.0.1"); await once(socket, "connect");
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n"); await once(socket, "data");
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem }); await once(secure, "secureConnect");
    const response = new Promise<string>((resolve, reject) => {
      let raw = "";
      secure.setTimeout(5000, () => secure.destroy(new Error("isolated request timed out")));
      secure.on("data", (b: Buffer) => { raw += b.toString(); }); secure.on("end", () => resolve(raw)); secure.on("error", reject);
    });
    const body = JSON.stringify({ model, stream, max_tokens: 128, messages });
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-claude-code-session-id: fallback-test\r\nx-claude-code-agent-id: worker-a\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    try { const raw = await response; return { status: Number(/^HTTP\/1.1 (\d+)/.exec(raw)?.[1]), raw }; }
    finally { secure.destroy(); }
  }
  try { await run({ cfg, seen, rawSeen, send, proxy, recover: () => { primaryAvailable = true; proxy.modelHealth.clear("p"); proxy.providerHealth.clear("p"); } }); }
  finally {
    proxy.close(); nativeAgent.destroy();
    upstream.closeAllConnections(); nativeUpstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => nativeUpstream.close(() => resolve()))]);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const stream of [false, true]) {
  for (const ladder of [false, true]) {
    test(`${ladder ? "LADDER" : "FAILOVER"} preserves target-owned thinking and stable prefixes (${stream ? "SSE" : "JSON"})`, async () => {
      await fixture(stream, async ({ send, seen, cfg }) => {
        cfg.routes.worker = { provider: "p", model: "primary", fallbacks: [{ provider: "q", model: "approved" }] };
        const first: Message = { role: "user", content: (ladder ? workerLadderLine({ pick: "hard-pick", model: "primary@high", fallbacks: ["approved@low"] }) + "\n" : "") + "Start" };
        const model = ladder ? "primary@high" : "worker";
        assert.equal((await send([first], model)).status, 410);
        const foreign: Block[] = [{ ...signed, signature: "unknown-signature" }, { ...redacted, data: "unknown-redaction" }];
        const foreignTurn: Message = { role: "assistant", content: [...foreign, text] };
        assert.equal((await send([first, foreignTurn], model)).status, 200);
        assert.deepEqual(seen.at(-1)?.messages, [first, { ...foreignTurn, content: [text] }]);
        const history: Message[] = [first, foreignTurn, { role: "assistant", content: own }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file bytes" }] }];
        assert.equal((await send(history, model)).status, 200);
        const prefix = seen.at(-1)?.messages;
        assert.deepEqual(prefix, [first, { ...foreignTurn, content: [text] }, ...history.slice(2)]);
        assert.equal((await send([...history, { role: "user", content: "next" }], model)).status, 200);
        assert.deepEqual(seen.at(-1)?.messages.slice(0, history.length), prefix);
      });
    });
  }
}

test("never-rerouted compatible request keeps unknown signed/redacted blocks", async () => {
  await fixture(false, async ({ send, seen, rawSeen }) => {
    const messages: Message[] = [{ role: "user", content: "Start" }, { role: "assistant", content: own }];
    const model = "approved";
    assert.equal((await send(messages, model)).status, 200);
    assert.deepEqual(seen.at(-1)?.messages, messages);
    assert.equal(rawSeen.at(-1), JSON.stringify({ model, stream: false, max_tokens: 128, messages }));
  });
});

test("native passthrough drops known foreign blocks but preserves unknown origins and unchanged bytes", async () => {
  await fixture(false, async ({ send, seen, rawSeen }) => {
    const model = "claude-opus-5-5";
    const first: Message = { role: "user", content: "Start" };
    const unknown = [{ ...signed, signature: "unknown-native" }, { ...redacted, data: "unknown-native" }];
    const messages: Message[] = [first, { role: "assistant", content: unknown }];
    assert.equal((await send(messages, model)).status, 200);
    assert.equal(rawSeen.at(-1), JSON.stringify({ model, stream: false, max_tokens: 128, messages }));
    // Both native and q have now returned these same blocks: native ownership must win.
    assert.equal((await send([first], "approved")).status, 200);
    assert.equal((await send([first, { role: "assistant", content: own }], model)).status, 200);
    assert.deepEqual(seen.at(-1)?.messages[1]?.content, own);
  });
  await fixture(false, async ({ send, seen }) => {
    const first: Message = { role: "user", content: "Start" };
    assert.equal((await send([first], "approved")).status, 200);
    const unknown = { ...signed, signature: "unknown-native" };
    assert.equal((await send([first, { role: "assistant", content: [...own, unknown] }], "claude-opus-5-5")).status, 200);
    assert.deepEqual(seen.at(-1)?.messages[1]?.content, [text, tool, unknown]);
  });
});

for (const stream of [false, true]) {
  for (const native of [false, true]) {
    for (const ladder of [false, true]) {
      // Native Anthropic is an explicit route target, never an inferred worker rung.
      if (native && ladder) continue;
      test(`recover preserves stable history, unknown origins and a second fallback (${stream ? "SSE" : "JSON"}, ${native ? "native" : ladder ? "LADDER" : "FAILOVER"})`, async () => {
        await fixture(stream, async ({ cfg, send, seen, proxy, recover }) => {
          cfg.routes.worker = { provider: "p", model: "primary", fallbacks: [{ provider: "q", model: "approved" }] };
          const first: Message = { role: "user", content: (ladder ? workerLadderLine({ pick: "hard-pick", model: "primary@high", fallbacks: ["approved@low"] }) + "\n" : "") + "Start" };
          const model = ladder ? "primary@high" : "worker";
          recover();
          assert.equal((await send([first], model)).status, 200);
          assert.equal(seen.at(-1)?.model, "primary");
          const history: Message[] = [first, { role: "assistant", content: primaryOwn }, { role: "user", content: "fallback now" }];
          const exhaust = () => proxy.providerHealth.observe("p", 429, { reason: "quota_exhausted", at: Date.now(), until: Date.now() + 60_000 });
          exhaust();
          assert.equal((await send(history, model)).status, 200);
          assert.equal(seen.at(-1)?.model, "approved");
          assert.deepEqual(seen.at(-1)?.messages[1]?.content, [text]);
          const unknown = [{ ...signed, signature: "unknown" }, { ...redacted, data: "unknown" }];
          history.push({ role: "assistant", content: [...own, ...unknown] }, { role: "user", content: "recovered" });
          recover();
          assert.equal((await send(history, model)).status, 200);
          if (ladder) {
            // A ladder worker stays on the fallback it moved to (#164): returning to the primary each
            // time it recovers would discard the prompt cache. Only FAILOVER returns, checked below.
            assert.equal(seen.at(-1)?.model, "approved");
            assert.deepEqual(seen.at(-1)?.messages[1]?.content, [text]);
            return;
          }
          assert.equal(seen.at(-1)?.model, "primary");
          assert.deepEqual(seen.at(-1)?.messages[1]?.content, primaryOwn);
          assert.deepEqual(seen.at(-1)?.messages[3]?.content, [text, tool, ...unknown]);
          const prefixBytes = JSON.stringify(seen.at(-1)?.messages);
          const next = [...history, { role: "assistant", content: primaryOwn }, { role: "user", content: "another turn" }];
          assert.equal((await send(next, model)).status, 200);
          assert.equal(JSON.stringify(seen.at(-1)?.messages.slice(0, history.length)), prefixBytes);
          exhaust();
          assert.equal((await send(next, model)).status, 200);
          assert.equal(seen.at(-1)?.model, "approved");
          assert.deepEqual(seen.at(-1)?.messages[3]?.content, own);
          assert.deepEqual(seen.at(-1)?.messages[5]?.content, [text]);
        }, native);
      });
    }
  }
}
