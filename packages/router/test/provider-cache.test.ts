import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";
import { OpenAiCompatibleAdapter } from "../src/providers/openai/index.ts";
import { StartInputs } from "../src/providers/start-input.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { Logger } from "../src/log.ts";

const credential = (accessToken: string, expiresAt = 1_000_000): string =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });

for (const missing of [null, "invalid JSON", JSON.stringify({ claudeAiOauth: {} })]) {
  test(`missing borrowed login is cached until the exact TTL boundary (${missing})`, () => {
    let now = 0;
    let reads = 0;
    let raw = missing;
    const store = new ClaudeCodeCredentialStore(() => { reads++; return raw; }, () => now);
    for (let call = 0; call < 100; call++) assert.ok(store.get() instanceof Error);
    assert.equal(reads, 1, "an absent or malformed login is one source read, not one per request");
    raw = credential("fake-new-login");
    now = 59_999;
    assert.ok(store.get() instanceof Error, "external login is discovered after the short negative TTL");
    assert.equal(reads, 1);
    now = 60_000;
    assert.deepEqual(store.get(), { accessToken: "fake-new-login", expiresAt: 1_000_000 });
    assert.equal(reads, 2);
    now = 119_999;
    store.get();
    assert.equal(reads, 2, "positive and negative results use the same TTL");
    now = 120_000;
    store.get();
    assert.equal(reads, 3);
  });
}

test("borrowed positive cache never extends token expiry and recovers on the next source check", () => {
  let now = 100;
  let raw = credential("fake-first", 200);
  let reads = 0;
  const store = new ClaudeCodeCredentialStore(() => { reads++; return raw; }, () => now);
  assert.deepEqual(store.get(), { accessToken: "fake-first", expiresAt: 200 });
  now = 199;
  assert.ok(!(store.get() instanceof Error));
  now = 200;
  const expired = store.get();
  assert.ok(expired instanceof Error);
  assert.match(expired.message, /login expired/);
  raw = credential("fake-refreshed");
  now = 60_099;
  assert.ok(store.get() instanceof Error);
  assert.equal(reads, 1, "an expired token is not returned or reread on every call");
  now = 60_100;
  assert.deepEqual(store.get(), { accessToken: "fake-refreshed", expiresAt: 1_000_000 });
  assert.equal(reads, 2);
});

test("explicit cache invalidation discovers sign-in, sign-out and replacement immediately", () => {
  let raw: string | null = null;
  let reads = 0;
  const store = new ClaudeCodeCredentialStore(() => { reads++; return raw; }, () => 0);
  assert.ok(store.get() instanceof Error);
  raw = credential("fake-signed-in");
  store.invalidate();
  assert.deepEqual(store.get(), { accessToken: "fake-signed-in", expiresAt: 1_000_000 });
  raw = null;
  store.invalidate();
  assert.ok(store.get() instanceof Error, "sign-out cannot retain a cached positive login");
  raw = credential("fake-replacement");
  store.invalidate();
  assert.deepEqual(store.get(), { accessToken: "fake-replacement", expiresAt: 1_000_000 });
  assert.equal(reads, 4);
});

test("a backwards clock rechecks borrowed credentials rather than extending a cache entry", () => {
  let now = 100;
  let reads = 0;
  const store = new ClaudeCodeCredentialStore(() => { reads++; return null; }, () => now);
  store.get();
  now = 99;
  store.get();
  assert.equal(reads, 2);
});

test("auth store passes its clock to borrowed source caching and preserves source precedence", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-provider-cache-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = 0;
  let raw: string | null = null;
  let keychainReads = 0;
  let fileReads = 0;
  let refreshes = 0;
  const env: NodeJS.ProcessEnv = {};
  const store = new ClaudeCodeAuthStore(undefined, {
    home, env, now: () => now,
    credentialReaders: {
      keychain: () => { keychainReads++; return raw; },
      credentialsFile: () => { fileReads++; return null; },
    },
    fetch: async () => { refreshes++; throw new Error("borrowed login must not refresh"); },
  });
  for (let call = 0; call < 20; call++) {
    assert.ok(store.get() instanceof Error);
    await store.refreshIfNeeded();
  }
  assert.deepEqual([keychainReads, fileReads, refreshes], [1, 1, 0]);
  raw = credential("fake-keychain", 60_100);
  now = 60_000;
  assert.deepEqual(store.get(), { source: "stored", credentials: { accessToken: "fake-keychain", expiresAt: 60_100 } });
  assert.deepEqual([keychainReads, fileReads], [2, 1], "valid keychain still wins over the file");
  env.CLAUDE_CODE_OAUTH_TOKEN = "fake-env";
  assert.deepEqual(store.get(), { source: "env", credentials: { accessToken: "fake-env", expiresAt: Infinity } });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  now = 60_100;
  assert.ok(store.get() instanceof Error, "auth store must respect borrowed token expiry, not just cache TTL");
  assert.deepEqual([keychainReads, fileReads, refreshes], [2, 1, 0]);
});

for (const source of ["keychain", "credentials-file", null] as const) {
  test(`source descriptions share the borrowed credential cache (${source})`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-source-cache-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    let now = 0;
    let keychainReads = 0;
    let fileReads = 0;
    const store = new ClaudeCodeAuthStore(undefined, {
      home, env: {}, now: () => now,
      credentialReaders: {
        keychain: () => { keychainReads++; return source === "keychain" ? credential("fake-keychain") : null; },
        credentialsFile: () => { fileReads++; return source === "credentials-file" ? credential("fake-file") : null; },
      },
    });
    for (let call = 0; call < 100; call++) {
      assert.equal(store.describeSource(), source);
      assert.equal(store.get() instanceof Error, source === null);
    }
    now = 59_999;
    assert.equal(store.describeSource(), source);
    assert.deepEqual([keychainReads, fileReads], [1, source === "keychain" ? 0 : 1]);
    now = 60_000;
    assert.equal(store.describeSource(), source);
    assert.deepEqual([keychainReads, fileReads], [2, source === "keychain" ? 0 : 2]);
    now--;
    assert.equal(store.describeSource(), source);
    assert.equal(keychainReads, 3, "a backwards clock rechecks source metadata too");
  });
}

test("source metadata follows expiry, precedence and explicit login invalidation", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-source-invalidation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = 0;
  let keychain: string | null = credential("fake-keychain", 100);
  let file: string | null = credential("fake-file");
  let reads = 0;
  const credentials = new ClaudeCodeCredentialStore({
    keychain: () => { reads++; return keychain; },
    credentialsFile: () => file,
  }, () => now);
  const observed = new ObservedClaudeCodeAuth();
  const env: NodeJS.ProcessEnv = {};
  const store = new ClaudeCodeAuthStore(credentials, { home, env, observed, now: () => now });
  assert.equal(store.describeSource(), "keychain");
  now = 100;
  assert.equal(store.describeSource(), null, "an expired keychain does not fall through to a file that get() would not use");
  assert.ok(store.get() instanceof Error);
  assert.equal(reads, 1, "expiry does not bypass the source TTL");
  keychain = null;
  credentials.invalidate();
  assert.equal(store.describeSource(), "credentials-file");
  assert.equal(reads, 2);
  file = null;
  credentials.invalidate();
  assert.equal(store.describeSource(), null, "sign-out clears the cached source label");
  keychain = credential("fake-replacement");
  credentials.invalidate();
  assert.equal(store.describeSource(), "keychain", "a new login is visible immediately");
  assert.equal(reads, 4);
  env.CLAUDE_CODE_OAUTH_TOKEN = "fake-env";
  assert.equal(store.describeSource(), "env");
  observed.observe(["authorization", "Bearer fake-observed"], now);
  assert.equal(store.describeSource(), "observed");
  store.forgetObserved("Bearer fake-observed");
  assert.equal(store.describeSource(), "env");
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.equal(store.describeSource(), "keychain");
  assert.equal(reads, 4, "higher-precedence sources and observed rejection do not reread the OS");
});

test("a negative borrowed cache does not mask observed login invalidation or a new sign-in", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-provider-login-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const observed = new ObservedClaudeCodeAuth();
  let reads = 0;
  const store = new ClaudeCodeAuthStore(undefined, {
    home, env: {}, observed, now: () => 0,
    credentialReaders: { keychain: () => { reads++; return null; }, credentialsFile: () => null },
  });
  assert.ok(store.get() instanceof Error);
  observed.observe(["authorization", "Bearer fake-first-login"], 0);
  const first = store.get();
  assert.ok(!(first instanceof Error));
  assert.equal(first.source, "observed");
  store.forgetObserved("Bearer fake-first-login");
  assert.ok(store.get() instanceof Error, "a rejected observed login is removed immediately");
  observed.observe(["authorization", "Bearer fake-first-login"], 0);
  assert.ok(store.get() instanceof Error, "the rejected token must not resurrect the login");
  observed.observe(["authorization", "Bearer fake-new-login"], 0);
  store.forgetObserved("Bearer fake-first-login");
  const recovered = store.get();
  assert.ok(!(recovered instanceof Error));
  assert.equal(recovered.source, "observed", "a new login wins immediately despite the negative cache");
  assert.equal(reads, 1, "observation and invalidation do not cause repeated OS credential reads");
});

test("adapter retains only a digest of the same start-input identity on both wires", async t => {
  const keys: string[] = [];
  const noted: string[] = [];
  const start = StartInputs.prototype.start;
  const note = StartInputs.prototype.note;
  t.mock.method(StartInputs.prototype, "start", function (this: StartInputs, key: string, estimate: number) {
    keys.push(key);
    return start.call(this, key, estimate);
  });
  t.mock.method(StartInputs.prototype, "note", function (this: StartInputs, key: string, usage: Parameters<StartInputs["note"]>[1]) {
    noted.push(key);
    return note.call(this, key, usage);
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls++;
    const records = String(url).endsWith("/responses")
      ? [{ type: "response.completed", response: { usage: { input_tokens: 40, output_tokens: 1 } } }]
      : [{ choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 1 } }];
    return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const log = new Logger(null, 1_000_000, 1, false);
  const base: AnthropicRequest = {
    model: "fake-client", stream: true, system: "fake-system-".repeat(10_000),
    messages: [{ role: "user", content: [
      { type: "text", text: "fake-opening" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==".repeat(10_000) } },
    ] }],
  };
  const firstUser = base.messages[0]!.content;
  assert.ok(Array.isArray(firstUser));
  const digest = (request: AnthropicRequest, model: string, wire: string): string => createHash("sha256")
    .update(JSON.stringify({ model, wire, system: request.system ?? "", user: request.messages.find(message => message.role === "user")?.content ?? "" }))
    .digest("hex");
  for (const wire of ["chat", "responses"] as const) {
    const adapter = new OpenAiCompatibleAdapter("fake", { type: "openai-compatible", url: "https://fake.invalid/v1", wire }, log);
    const run = async (json: AnthropicRequest, model = "fake-model"): Promise<number> => {
      let text = "";
      const res = Object.assign(new EventEmitter(), {
        headersSent: false, writableEnded: false, destroyed: false,
        writeHead() { this.headersSent = true; return this; },
        write(body: string) { text += body; return true; },
        end() { this.writableEnded = true; return this; },
      }) as unknown as http.ServerResponse;
      const before = keys.length;
      const outcome = await adapter.handle({} as http.IncomingMessage, res, "/v1/messages", json, model, undefined);
      assert.equal(outcome.status, 200);
      assert.equal(keys.length, before + 1, "one start lookup per request");
      assert.equal(keys.at(-1), digest(json, model, wire));
      assert.equal(noted.at(-1), keys.at(-1), "usage updates the same digest, not the serialized body");
      const event = text.split("\n\n").find(event => event.startsWith("event: message_start\n"))!;
      return (JSON.parse(event.split("\ndata: ")[1]!) as { message: { usage: { input_tokens: number } } }).message.usage.input_tokens;
    };
    const estimate = await run(base);
    const first = keys.at(-1)!;
    assert.equal(await run(structuredClone(base)), 40, "equal inputs reuse the measured ratio");
    assert.equal(keys.at(-1), first);
    await run({ ...base, messages: [...base.messages, { role: "assistant", content: "fake-answer" }, { role: "user", content: "fake-follow-up" }] });
    assert.equal(keys.at(-1), first, "later turns keep the original identity");
    for (const different of [
      { ...base, system: "different-system" },
      { ...base, messages: [{ role: "user" as const, content: "different-opening" }] },
      { ...base, messages: [{ role: "user" as const, content: [firstUser[0]!, { type: "image", source: { type: "base64", media_type: "image/png", data: "b3RoZXI=" } }] }] },
    ]) {
      await run(different);
      assert.notEqual(keys.at(-1), first);
    }
    assert.equal(await run(base, "another-model"), estimate, "a model gets its own unmeasured estimate");
    assert.notEqual(keys.at(-1), first);
  }
  assert.notEqual(keys[0], keys[7], "wire remains part of the identity");
  assert.equal(calls, keys.length, "no extra upstream requests are introduced");
  for (const key of [...keys, ...noted]) assert.match(key, /^[a-f0-9]{64}$/, "bounded keys retain no prompt or image payload");
});
