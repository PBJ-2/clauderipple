import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { HostServer } from "../src/server.ts";
import type { HostMsg } from "../src/protocol.ts";

const webDir = fileURLToPath(new URL("../web", import.meta.url));
const token = "remote-test-token-not-a-real-pairing-token";

function stubSessions(decide: (session: string, id: string, decision: string) => Promise<boolean> | boolean = () => true) {
  return {
    list: () => [], groups: () => undefined, has: () => false, pollDesktop: async () => {}, pollQueued: () => {}, tailUnwatched: () => {}, watchAttached: () => {},
    decide: (session: string, id: string, decision: "allow" | "allow_always" | "deny") => decide(session, id, decision),
  };
}

function serve(t: import("node:test").TestContext, sessions: ReturnType<typeof stubSessions>): Promise<HostServer> {
  const server = new HostServer({
    listen: "127.0.0.1", port: 0, token, webDir,
    sessions: sessions as never,
    router: { models: async () => [], status: async () => ({ ok: true, proxyEnv: {} }) },
    hostName: "test", version: "test", recentCli: async () => [],
  });
  t.after(() => server.close());
  return server.listen().then(() => server);
}

function get(port: number, target: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method: "GET" }, res => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

function hello(port: number, tokenValue: string, clientId: unknown): Promise<{ frames: HostMsg[]; closed: { code: number } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: HostMsg[] = [];
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token: tokenValue, clientId })));
    ws.on("message", data => { frames.push(JSON.parse(String(data)) as HostMsg); });
    ws.on("close", code => resolve({ frames, closed: { code } }));
    ws.on("error", reject);
    setTimeout(() => resolve({ frames, closed: { code: -1 } }), 1500);
  });
}

test("malformed percent-encoding is a 400 and the host survives it", async t => {
  const server = await serve(t, stubSessions());
  const port = server.address().port;
  assert.equal((await get(port, "/healthz")).status, 200);
  assert.equal((await get(port, "/%E0%A4%A")).status, 400);
  assert.equal((await get(port, "/%00")).status, 400);
  assert.equal((await get(port, "/healthz")).status, 200);
  assert.equal((await get(port, "/%2e%2e/%2e%2e/etc/passwd")).status, 404);
});

test("hello rejects clientIds outside [A-Za-z0-9_-] and keeps good ones", async t => {
  const server = await serve(t, stubSessions());
  const port = server.address().port;
  for (const bad of ["evil;id!", "../../x", "a b", "x".repeat(101), "id+tag", "pixel-9_pro.2026"]) {
    const r = await hello(port, token, bad);
    assert.equal(r.frames[0]?.t, "denied", `clientId ${JSON.stringify(bad)} must be denied`);
    assert.equal(r.closed.code, 4003);
  }
  const good = await hello(port, token, "pixel-9_pro-2026");
  assert.equal(good.frames[0]?.t, "ready");
  const empty = await hello(port, token, "");
  assert.equal(empty.frames[0]?.t, "ready");
});

test("a forged decide decision is an error to the phone, never to the queue", async t => {
  let calls = 0;
  const server = await serve(t, stubSessions(() => { calls++; return true; }));
  const port = server.address().port;
  const answer = await new Promise<HostMsg>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", token, clientId: "phone-1" }));
      setTimeout(() => ws.send(JSON.stringify({ t: "decide", session: "s", id: "p", decision: "expired", reqId: "r1" })), 100);
    });
    ws.on("message", data => {
      const msg = JSON.parse(String(data)) as HostMsg;
      if (msg.t === "res") { resolve(msg); ws.close(); }
    });
  });
  assert.equal(calls, 0);
  assert.ok(answer.t === "res" && answer.ok === false && /invalid decision/.test(answer.error));
});
