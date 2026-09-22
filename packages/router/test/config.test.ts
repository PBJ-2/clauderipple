import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, DEFAULTS, providerFor, validate } from "../src/config.ts";
import type { AnthropicCompatibleProvider, OpenAiCompatibleProvider } from "../src/config.ts";
import { Logger } from "../src/log.ts";

test("validate reports unknown providers and bad urls", () => {
  const errs = validate({
    ...DEFAULTS,
    providers: { p: { type: "anthropic-compatible", url: "127.0.0.1:1" } },
    routes: { a: { provider: "nope", model: "m" } },
    direct: [{ prefix: "x", provider: "p" }],
  });
  assert.equal(errs.length, 2);
});

test("validate accepts named anthropic-compatible model entries and rejects invalid ones", () => {
  const valid = validate({
    ...DEFAULTS,
    providers: { p: { type: "anthropic-compatible", url: "https://example.test", preset: "example", models: [{ id: "model", name: "Model" }] } },
  });
  assert.deepEqual(valid, []);
  const invalid = validate({
    ...DEFAULTS,
    providers: { p: { type: "anthropic-compatible", url: "https://example.test", models: [{ id: 7 } as unknown as { id: string }] } },
  });
  assert.ok(invalid.some((error) => error.includes("models must be entries")));
});

test("validate accepts native Anthropic providers and confines account pools to Claude login auth", () => {
  assert.deepEqual(validate({ ...DEFAULTS, providers: { api: { type: "anthropic", auth: "api-key" }, login: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5" }] } } }), []);
  assert.ok(validate({ ...DEFAULTS, providers: { bad: { type: "anthropic", auth: "bad" as "api-key" } } }).some((error) => error.includes("auth must be")));
  assert.ok(validate({ ...DEFAULTS, providers: { bad: { type: "anthropic", auth: "api-key", accountPool: true } } }).some((error) => error.includes('requires auth "claude-code"')));
  assert.ok(validate({ ...DEFAULTS, providers: { bad: { type: "anthropic", auth: "claude-code", accountPool: "yes" as unknown as boolean } } }).some((error) => error.includes("must be true or false")));
});

test("validate accepts compatible caps and rejects invalid values", () => {
  const valid = validate({
    ...DEFAULTS,
    providers: { p: { type: "anthropic-compatible", url: "https://example.test", caps: { effortLevels: ["low", "high"], thinking: "enabled", betas: true, cacheControl: false } } },
  });
  assert.deepEqual(valid, []);
  const invalid = validate({
    ...DEFAULTS,
    providers: { p: { type: "anthropic-compatible", url: "https://example.test", caps: { effortLevels: [3] as unknown as string[], thinking: "adaptive" as "enabled" } } },
  });
  assert.ok(invalid.some((error) => error.includes("caps must contain")));
});

test("validate accepts openai-compatible configuration and rejects invalid wire/caps", () => {
  const valid = validate({
    ...DEFAULTS,
    providers: { oai: { type: "openai-compatible", url: "https://api.example.test/v1", headers: { authorization: "Bearer key" }, wire: "responses", models: [{ id: "model", name: "Model", effortLevels: ["low", "high"] }], caps: { reasoning: "effort", effortLevels: ["low", "high"] } } },
  });
  assert.deepEqual(valid, []);
  const invalid = validate({
    ...DEFAULTS,
    providers: { oai: { type: "openai-compatible", url: "https://api.example.test/v1", wire: "invalid" as "chat", caps: { reasoning: "invalid" as "effort" } } },
  });
  assert.ok(invalid.some((error) => error.includes("wire")));
  assert.ok(invalid.some((error) => error.includes("caps")));
  const invalidModel = validate({
    ...DEFAULTS,
    providers: { oai: { type: "openai-compatible", url: "https://api.example.test/v1", models: [{ id: "model", effortLevels: [7] as unknown as string[] }] } },
  });
  assert.ok(invalidModel.some((error) => error.includes("models must be entries")));
});

test("ConfigStore hot-reloads on mtime change and keeps last good config on errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-cfg-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ listen: { port: 1234 } }));
  const store = new ConfigStore(file);
  assert.equal(store.get().listen.port, 1234);
  assert.equal(store.get().listen.host, "127.0.0.1");
  fs.writeFileSync(file, "{ broken");
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(store.get().listen.port, 1234);
  fs.writeFileSync(file, JSON.stringify({ listen: { port: 4321 } }));
  fs.utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  assert.equal(store.get().listen.port, 4321);
});

// One OpenCode Go account needed three providers, because `wire` and `url` sat on the provider
// while the models on that one key speak three different protocols. Every `direct` rule had to name
// whichever third its model lived in, and the user saw a split they never asked for. A config
// written that way is folded on the way in.
test("the three providers one OpenCode Go account needed are read as one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-fold-"));
  const file = path.join(dir, "config.json");
  const shared = { sessionHeader: "x-opencode-session", headers: { authorization: "Bearer sk-test" } };
  fs.writeFileSync(file, JSON.stringify({
    providers: {
      "opencode-go-responses": {
        type: "openai-compatible", url: "https://opencode.ai/zen/go/v1", preset: "opencode-go", wire: "responses",
        caps: { effortLevels: ["low", "high", "xhigh"], reasoning: "effort" }, models: [{ id: "muse-spark-1.3-contributor" }], ...shared,
      },
      "opencode-go-chat": {
        type: "openai-compatible", url: "https://opencode.ai/zen/go/v1", preset: "opencode-go-chat", wire: "chat",
        caps: { effortLevels: [], reasoning: "none" }, models: [{ id: "deepseek-v4.1-flash" }], ...shared,
      },
      "opencode-go-anthropic": {
        type: "anthropic-compatible", url: "https://opencode.ai/zen/go", preset: "opencode-go-anthropic",
        models: [{ id: "minimax-m3" }], sessionHeader: "x-opencode-session", headers: { "x-api-key": "sk-test" },
      },
      other: { type: "anthropic", auth: "api-key" },
    },
    direct: [{ prefix: "deepseek-v4.1", provider: "opencode-go-chat" }, { prefix: "gpt-", provider: "other" }],
  }));
  let errors: string[] = ["not called"];
  const cfg = new ConfigStore(file, (_c, e) => { errors = e; }).get();
  // The folded config is what gets validated, so a reference left behind would surface here.
  assert.deepEqual(errors, []);

  assert.deepEqual(Object.keys(cfg.providers).sort(), ["opencode-go", "other"]);
  const merged = cfg.providers["opencode-go"] as OpenAiCompatibleProvider;
  assert.deepEqual(merged.models?.map((m) => m.id), ["muse-spark-1.3-contributor", "deepseek-v4.1-flash", "minimax-m3"]);
  assert.equal(merged.sessionHeader, "x-opencode-session", "the cache key every third sent is still sent");
  // A rule that named a third names the provider now, or the config stops validating on a provider
  // the user never removed.
  assert.deepEqual(cfg.direct, [{ prefix: "deepseek-v4.1", provider: "opencode-go" }, { prefix: "gpt-", provider: "other" }]);

  // Each model kept the endpoint, wire and auth convention its own third had, so which one became
  // the base cannot change where a request goes.
  const responses = providerFor(merged, "muse-spark-1.3-contributor") as OpenAiCompatibleProvider;
  assert.equal(responses.type, "openai-compatible");
  assert.equal(responses.wire, "responses");
  assert.equal(responses.url, "https://opencode.ai/zen/go/v1");

  const chat = providerFor(merged, "deepseek-v4.1-flash") as OpenAiCompatibleProvider;
  assert.equal(chat.wire, "chat");
  // The Responses ladder must not follow it: the chat endpoint published no effort contract, and
  // inheriting one would start sending an effort it never accepted.
  assert.deepEqual(merged.models?.find((m) => m.id === "deepseek-v4.1-flash")?.effortLevels, []);
  assert.deepEqual(merged.models?.find((m) => m.id === "muse-spark-1.3-contributor")?.effortLevels, ["low", "high", "xhigh"]);

  // Anthropic Messages needs no translation, so this one is served by the other adapter, on the
  // base that is deliberately one segment shorter, under the header that endpoint recognises — with
  // the provider's key carried across rather than restated in the model entry.
  const native = providerFor(merged, "minimax-m3") as AnthropicCompatibleProvider;
  assert.equal(native.type, "anthropic-compatible");
  assert.equal(native.url, "https://opencode.ai/zen/go");
  assert.deepEqual(native.headers, { "x-api-key": "sk-test" }, "one copy of the key, under the convention this wire wants");
});

test("one OpenCode Go provider on its own is not a split, and is left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-fold-one-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    providers: {
      "opencode-go-chat": {
        type: "openai-compatible", url: "https://opencode.ai/zen/go/v1", preset: "opencode-go-chat",
        wire: "chat", models: [{ id: "deepseek-v4.1-flash" }],
      },
    },
    direct: [{ prefix: "deepseek-v4.1", provider: "opencode-go-chat" }],
  }));
  const cfg = new ConfigStore(file).get();
  assert.deepEqual(Object.keys(cfg.providers), ["opencode-go-chat"], "nothing to merge, so nothing is renamed");
  assert.equal(cfg.direct[0]?.provider, "opencode-go-chat");
  const only = cfg.providers["opencode-go-chat"] as OpenAiCompatibleProvider;
  assert.equal(only.models?.[0]?.wire, undefined, "no override is invented where the provider still describes its models");
});

test("Logger rotates by size and keeps N files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-log-"));
  const file = path.join(dir, "router.log");
  const log = new Logger(file, 2000, 2, false);
  for (let i = 0; i < 400; i++) log.info("x".repeat(40));
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ["router.log", "router.log.1", "router.log.2"]);
  assert.ok(fs.statSync(file).size < 5000);
});

// A fallback is only reached once something has already failed, so a broken one shows up on the
// worst possible day. These are refused at save time instead.
test("validate refuses fallbacks that name nothing, or repeat the primary", () => {
  const cfg = (fallbacks: unknown) => validate({
    ...DEFAULTS,
    providers: {
      p: { type: "anthropic-compatible", url: "https://example.test" },
      q: { type: "anthropic-compatible", url: "https://other.test" },
    },
    routes: { slot: { provider: "p", model: "m", fallbacks } as never },
  });

  assert.deepEqual(cfg([{ provider: "q", model: "n" }]), [], "a real second target is fine");
  assert.deepEqual(cfg(undefined), [], "no fallbacks at all is the normal case");
  assert.ok(cfg([{ provider: "gone", model: "n" }])[0]?.includes("unknown provider"));
  assert.ok(cfg([{ provider: "q" }])[0]?.includes("missing model"));
  assert.ok(cfg([{ provider: "p", model: "m" }])[0]?.includes("repeats the primary"));
  assert.ok(cfg("nope")[0]?.includes("must be a list"));
});

// Credential ids key the cooldown and quarantine state. Two credentials sharing one id would share
// one health record and take each other down.
test("validate refuses a credential pool with duplicate ids or non-string headers", () => {
  const cfg = (credentials: unknown) => validate({
    ...DEFAULTS,
    providers: { p: { type: "anthropic-compatible", url: "https://example.test", credentials } as never },
  });

  assert.deepEqual(cfg([{ id: "one", headers: { "x-api-key": "k" } }, { id: "two", headers: {}, label: "spare" }]), []);
  assert.deepEqual(cfg(undefined), [], "a provider with one credential is unchanged");
  assert.ok(cfg([{ id: "same", headers: {} }, { id: "same", headers: {} }])[0]?.includes("used twice"));
  assert.ok(cfg([{ headers: {} }])[0]?.includes("non-empty id"));
  assert.ok(cfg([{ id: "a", headers: { key: 5 } }])[0]?.includes("string record"));
  assert.ok(cfg([{ id: "a", headers: {}, label: 7 }])[0]?.includes("label must be a string"));
});
