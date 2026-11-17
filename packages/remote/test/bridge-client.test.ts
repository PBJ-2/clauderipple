import test from "node:test";
import assert from "node:assert/strict";
import { BridgeClient, bridgeCreateNotCreated, decodeSse } from "../src/bridge-client.ts";
import type { InputBlock } from "../src/images.ts";

const auth = () => ({ accessToken: "secret-not-for-phone", organizationUuid: "org", expiresAt: Date.now() + 60_000 });
const frame = (sequence: number) => `event: client_event\r\ndata: ${JSON.stringify({ sequence_num: sequence, event_id: `e${sequence}`, source: "worker", payload: { type: "control_cancel_request", request_id: "r" } })}\r\n\r\n`;

test("session reads use GET and decode both CLI envelopes, rejecting invalid worker state", async () => {
  for (const worker_status of ["running", "idle", "requires_action"]) {
    const session = { worker_status, status: "active", status_bucket: "working", connection_status: "connected" };
    for (const body of [session, { session }, { response_shape: session }]) {
      const client = new BridgeClient({ auth, fetch: async (url, options) => {
        assert.equal(String(url), "https://api.anthropic.com/v1/code/sessions/bridge%2Fid");
        assert.equal(options?.method, "GET");
        assert.equal(options?.body, undefined);
        return Response.json(body);
      } });
      assert.deepEqual(await client.session("bridge/id"), session);
    }
  }
  for (const body of [null, {}, { session: { worker_status: "unknown" } }]) {
    const client = new BridgeClient({ auth, fetch: async () => Response.json(body) });
    await assert.rejects(client.session("bridge"), /valid worker status/);
  }
});

test("client writes exact prompt, permission and interrupt envelopes, never worker registration", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const client = new BridgeClient({ auth, fetch: async (url, options) => { calls.push({ url: String(url), options: options! }); return new Response("{}"); } });
  await client.send("bridge", "uuid", "hello");
  await client.post("bridge", { type: "control_response", response: { subtype: "success", request_id: "r", response: { behavior: "allow", updatedInput: { command: "true" }, toolUseID: "t" } } });
  await client.interrupt("bridge");
  assert.deepEqual(JSON.parse(String(calls[0]?.options.body)), { session_id: "bridge", events: [{ payload: { type: "user", uuid: "uuid", message: { role: "user", content: "hello" }, parent_tool_use_id: null } }] });
  assert.ok(calls.every(call => call.url === "https://api.anthropic.com/v1/code/sessions/bridge/events"));
  const headers = new Headers(calls[0]?.options.headers);
  assert.equal(headers.get("authorization"), "Bearer secret-not-for-phone");
  assert.equal(headers.get("x-organization-uuid"), "org");
  assert.equal(headers.get("anthropic-beta"), null);
  assert.equal(JSON.parse(String(calls[2]?.options.body)).events[0].payload.request.subtype, "interrupt");
});

test("environment creation uses the collection endpoint once and reads either session id envelope", async () => {
  for (const body of [{ session: { id: "cse_nested" } }, { id: "cse_top" }]) {
    let calls = 0;
    const client = new BridgeClient({ auth, fetch: async (url, options) => {
      calls++;
      assert.equal(String(url), "https://api.anthropic.com/v1/code/sessions");
      assert.equal(options?.method, "POST");
      assert.deepEqual(JSON.parse(String(options?.body)), { title: "Title", events: [], environment_id: "env_test", config: { sources: [] } });
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("x-organization-uuid"), "org");
      assert.equal(headers.get("anthropic-client-platform"), "ios");
      assert.equal(headers.get("anthropic-beta"), null);
      return Response.json(body);
    } });
    assert.equal(await client.createEnvironmentSession("env_test", "Title"), "session" in body ? "cse_nested" : "cse_top");
    assert.equal(calls, 1);
  }
});

test("environment creation distinguishes definite refusals from unknown outcomes without retrying", async () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    let calls = 0;
    const client = new BridgeClient({ auth, fetch: async () => { calls++; return new Response("secret-not-for-phone", { status }); } });
    await assert.rejects(client.createEnvironmentSession("env_test", "Title"), error => {
      assert.equal(bridgeCreateNotCreated(error), status < 500);
      assert.ok(error instanceof Error && !error.message.includes("secret-not-for-phone"));
      return true;
    });
    assert.equal(calls, 1);
  }
  for (const response of [() => { throw new Error("connection lost"); }, () => new Response("not json"), () => Response.json({})]) {
    let calls = 0;
    const client = new BridgeClient({ auth, fetch: async () => { calls++; return response(); } });
    await assert.rejects(client.createEnvironmentSession("env_test", "Title"), error => !bridgeCreateNotCreated(error));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const expired = new BridgeClient({ auth: () => ({ ...auth(), expiresAt: 0 }), fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(expired.createEnvironmentSession("env_test", "Title"), bridgeCreateNotCreated);
  assert.equal(calls, 0);
});

test("client sends image and text blocks unchanged in the user envelope", async () => {
  const content: InputBlock[] = [
    { type: "image", source: { type: "base64", media_type: "image/webp", data: "cGhvdG8=" } },
    { type: "text", text: "Describe this photo" },
  ];
  let calls = 0;
  const client = new BridgeClient({ auth, fetch: async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.anthropic.com/v1/code/sessions/bridge/events");
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), {
      session_id: "bridge", events: [{ payload: { type: "user", uuid: "uuid", message: { role: "user", content }, parent_tool_use_id: null } }],
    });
    return new Response("{}");
  } });
  await client.send("bridge", "uuid", content);
  assert.equal(calls, 1);
});

test("expired auth never calls fetch; rejected writes are not retried and errors cannot leak token", async () => {
  let calls = 0;
  const expired = new BridgeClient({ auth: () => ({ ...auth(), expiresAt: 0 }), fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(expired.send("b", "u", "text"), /Claude 로그인이 만료되었습니다/);
  assert.equal(calls, 0);
  for (const status of [401, 403, 400, 500]) {
    const client = new BridgeClient({ auth, fetch: async () => { calls++; return new Response("secret-not-for-phone signature_wanted", { status }); } });
    await assert.rejects(client.send("b", "u", "text"), error => error instanceof Error && error.message.includes(`(${status})`) && !error.message.includes("secret-not-for-phone"));
  }
  assert.equal(calls, 4);
  const client = new BridgeClient({ auth, fetch: async () => { throw new Error("secret-not-for-phone"); } });
  await assert.rejects(client.send("b", "u", "text"), error => error instanceof Error && !error.message.includes("secret-not-for-phone"));
});

test("SSE handles split UTF-8 and CRLF frames", async () => {
  const bytes = new TextEncoder().encode(`event: ephemeral_event\r\ndata: {"payload":{"text":"한글"}}\r\n\r\n` + frame(1));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1)); controller.close(); } });
  const frames = [];
  for await (const value of decodeSse(stream)) frames.push(value);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0]?.data, { payload: { text: "한글" } });
});

test("stream reconnects from applied sequence and drops repeated durable events", async () => {
  const urls: string[] = [];
  const abort = new AbortController();
  const client = new BridgeClient({ auth, fetch: async url => { urls.push(String(url)); if (String(url).includes("sort_order=desc")) return Response.json({ data: [{ sequence_num: "3" }] }); return new Response(urls.length === 2 ? frame(4) : frame(4) + frame(5)); } });
  const sequences: unknown[] = [];
  await client.stream("b", abort.signal, event => { sequences.push(event.data.sequence_num); if (event.data.sequence_num === 5) abort.abort(); });
  assert.deepEqual(sequences, [4, 5]);
  assert.ok(urls[1]?.endsWith("from_sequence_num=3"), "starts at the newest event, not 0");
  assert.ok(urls[2]?.endsWith("from_sequence_num=4"));
});

test("stream HTTP auth refusal is terminal", async () => {
  let calls = 0;
  const client = new BridgeClient({ auth, fetch: async () => { calls++; return new Response("untrusted_device", { status: 403 }); } });
  await assert.rejects(client.stream("b", new AbortController().signal, () => {}), /\(403\)/);
  assert.equal(calls, 1);
});

test("openRequests replays from the start cursor, skipping answered and withdrawn ones", async () => {
  const requested = (request_id: string, input: unknown) => ({ payload: { type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: `t-${request_id}`, input } } });
  const stored = [
    requested("r1", { command: "a" }),
    { payload: { type: "system", subtype: "init" } },
    requested("r2", { command: "b" }),
    // This host's own answer is stored under the posting client's source, with the id nested.
    { source: "client", payload: { type: "control_response", response: { subtype: "success", request_id: "r1" } } },
    requested("r3", { command: "c" }),
    { payload: { type: "control_cancel_request", request_id: "r3" } },
    { source: "client", payload: { type: "control_request", request_id: "r4", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "t-r4", input: { command: "d" } } } },
  ];
  const urls: string[] = [];
  const client = new BridgeClient({ auth, fetch: async url => { urls.push(String(url)); return Response.json({ data: stored }); } });
  assert.deepEqual(await client.openRequests("b"), [{ requestId: "r2", tool: "Bash", input: { command: "b" }, toolUseId: "t-r2" }]);
  assert.deepEqual(urls, ["https://api.anthropic.com/v1/code/sessions/b/events?sort_order=asc"]);
});

// Issue #169: the CLI's keychain login and the Claude app can be two accounts. The organization comes
// from the app's `.claude.json`, so the CLI's token is answered 404 (another account's session is
// never admitted to exist) while the token the router saw the app use is answered 200.
const clock = 1_700_000_000_000;
const split = (observed: boolean) => () => ({
  accessToken: "keychain-token-b", organizationUuid: "org-a", expiresAt: clock + 3_600_000,
  ...(observed ? { alternate: { accessToken: "observed-token-a", expiresAt: clock + 600_000 } } : {}),
});
const byToken = (seen: string[], accepted: string) => async (_url: unknown, options?: RequestInit) => {
  const token = new Headers(options?.headers).get("authorization")!.slice("Bearer ".length);
  seen.push(token);
  return token === accepted ? Response.json({ worker_status: "idle" }) : new Response("{}", { status: 404 });
};

test("a keychain login of another account is answered 404, then the observed login serves and is kept", async () => {
  const seen: string[] = [];
  const client = new BridgeClient({ auth: split(true), now: () => clock, fetch: byToken(seen, "observed-token-a") });
  assert.deepEqual(await client.session("s"), { worker_status: "idle" });
  assert.deepEqual(seen, ["keychain-token-b", "observed-token-a"]);
  await client.session("s");
  await client.send("s", "u", "hi");
  assert.deepEqual(seen.slice(2), ["observed-token-a", "observed-token-a"], "the working login is kept, no 404 round trip again");
});

test("a 404 to both logins fails once and never loops, and the keychain login stays first", async () => {
  const seen: string[] = [];
  const client = new BridgeClient({ auth: split(true), now: () => clock, fetch: byToken(seen, "nobody") });
  await assert.rejects(client.session("s"), /\(404\)/);
  assert.deepEqual(seen, ["keychain-token-b", "observed-token-a"]);
  await assert.rejects(client.session("s"), /\(404\)/);
  assert.equal(seen[2], "keychain-token-b");
  assert.equal(seen.length, 4);
});

test("the keychain login of the same account is used as before, with no second request", async () => {
  const seen: string[] = [];
  const client = new BridgeClient({ auth: split(true), now: () => clock, fetch: byToken(seen, "keychain-token-b") });
  await client.session("s");
  await client.session("s");
  assert.deepEqual(seen, ["keychain-token-b", "keychain-token-b"]);
});

test("without an observed login a 404 stays a 404 on the keychain login alone", async () => {
  const seen: string[] = [];
  const client = new BridgeClient({ auth: split(false), now: () => clock, fetch: byToken(seen, "observed-token-a") });
  await assert.rejects(client.session("s"), /\(404\)/);
  assert.deepEqual(seen, ["keychain-token-b"]);
});

test("once the CLI is signed in again with a new token, that token is tried first, not the kept observed one", async () => {
  const seen: string[] = [];
  let keychain = "keychain-token-b";
  let now = clock;
  let accepted = "observed-token-a";
  const auth = () => ({ accessToken: keychain, organizationUuid: "org-a", expiresAt: now + 3_600_000, alternate: { accessToken: "observed-token-a", expiresAt: now + 600_000 } });
  const client = new BridgeClient({ auth, now: () => now, fetch: async (url, options) => byToken(seen, accepted)(url, options) });
  await client.session("s");
  assert.deepEqual(seen, ["keychain-token-b", "observed-token-a"]);
  // The CLI signs in to the app's account; the kept login nears expiry, so the next request rereads.
  keychain = "keychain-token-a2";
  accepted = "keychain-token-a2";
  now += 60 * 60_000;
  assert.deepEqual(await client.session("s"), { worker_status: "idle" });
  assert.deepEqual(seen.slice(2), ["keychain-token-a2"]);
});

test("a 401 to the observed login after a 404 does not mark the keychain login refused", async () => {
  const seen: string[] = [];
  const client = new BridgeClient({
    auth: split(true), now: () => clock,
    fetch: async (url, options) => {
      const token = new Headers(options?.headers).get("authorization")!.slice("Bearer ".length);
      seen.push(token);
      if (String(url).includes("/retired")) return new Response("{}", { status: token === "observed-token-a" ? 401 : 404 });
      return token === "keychain-token-b" ? Response.json({ worker_status: "idle" }) : new Response("{}", { status: 404 });
    },
  });
  await assert.rejects(client.session("retired"), /\(404\)/);
  assert.deepEqual(await client.session("live"), { worker_status: "idle" });
  assert.equal(seen.at(-1), "keychain-token-b");
});

test("a 5xx to the observed login after a 404 stays a 5xx, an unknown outcome for a write", async () => {
  const client = new BridgeClient({
    auth: split(true), now: () => clock,
    fetch: async (_url, options) => {
      const token = new Headers(options?.headers).get("authorization")!.slice("Bearer ".length);
      return new Response("{}", { status: token === "observed-token-a" ? 502 : 404 });
    },
  });
  await assert.rejects(client.send("s", "u", "hi"), /\(502\)/);
});

test("loadBridgeAuth hands the observed login along as the alternate only when it is another token", async () => {
  const { loadBridgeAuth } = await import("../src/bridge-client.ts");
  const files: Record<string, string> = { "/h/.claude.json": JSON.stringify({ oauthAccount: { organizationUuid: "org-a", accountUuid: "acc-a" } }) };
  const base = { platform: "darwin" as const, userHome: "/h", now: clock, readFile: (f: string) => files[f]! };
  const cli = { accessToken: "keychain-token-b", expiresAt: clock + 3_600_000 };
  const observed = { accessToken: "observed-token-a", expiresAt: clock + 600_000 };
  const different = loadBridgeAuth({ ...base, cli: () => cli, observed: () => observed });
  assert.equal(different.accessToken, "keychain-token-b");
  assert.deepEqual(different.alternate, observed);
  assert.equal(loadBridgeAuth({ ...base, cli: () => cli, observed: () => ({ ...observed, accessToken: "keychain-token-b" }) }).alternate, undefined);
  assert.equal(loadBridgeAuth({ ...base, cli: () => cli, observed: () => null }).alternate, undefined);
});
