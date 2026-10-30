import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, DEFAULTS, PROCESS_PRIORITIES, fastSwitches, providerFor, validate } from "../src/config.ts";
import type { AnthropicCompatibleProvider, Config, GoogleProvider, OpenAiCompatibleProvider, ProcessPriority, Provider } from "../src/config.ts";
import { Logger } from "../src/log.ts";

test("validate accepts only the four process priority settings", () => {
  assert.deepEqual(PROCESS_PRIORITIES, ["below-normal", "normal", "above-normal", "high"]);
  for (const processPriority of PROCESS_PRIORITIES) {
    assert.deepEqual(validate({ ...DEFAULTS, processPriority }), [], processPriority);
  }
  const message = 'processPriority must be "below-normal", "normal", "above-normal" or "high"';
  for (const processPriority of ["realtime", "High", 1]) {
    const config = { ...DEFAULTS, processPriority: processPriority as unknown as ProcessPriority };
    assert.deepEqual(validate(config), [message]);
  }
});

test("validate rejects an unusable Auto mode classifier target", () => {
  const providers = { p: { type: "chatgpt" as const } };
  assert.deepEqual(validate({ ...DEFAULTS, providers, autoModeClassifier: { provider: "p", model: "gpt-6-luna", effort: "low" } }), []);
  assert.ok(validate({ ...DEFAULTS, providers, autoModeClassifier: { provider: "missing", model: "gpt-6-luna" } }).some((e) => e.includes("unknown provider")));
  assert.ok(validate({ ...DEFAULTS, providers, autoModeClassifier: { provider: "p", model: "" } }).some((e) => e.includes("missing model")));
  assert.ok(validate({ ...DEFAULTS, providers: { p: { type: "anthropic", auth: "claude-code" } }, autoModeClassifier: { provider: "p", model: "claude-sonnet-5" } }).some((e) => e.includes("ingress-only")));
});

test("validate checks the Auto mode classifier's first-stage target like the main one", () => {
  const providers = { p: { type: "chatgpt" as const }, cls: { type: "anthropic" as const, auth: "claude-code" as const, accountPool: true } };
  const main = { provider: "p", model: "gpt-6-luna", effort: "high" };
  const errors = (stage1: unknown) => validate({ ...DEFAULTS, providers, autoModeClassifier: { ...main, stage1: stage1 as { provider: string; model: string } } });
  assert.deepEqual(errors({ provider: "cls", model: "claude-sonnet-5-5" }), []);
  assert.deepEqual(errors({ provider: "missing", model: "claude-sonnet-5-5" }), ["autoModeClassifier.stage1: unknown provider"]);
  assert.deepEqual(errors({ provider: "cls", model: " " }), ["autoModeClassifier.stage1: missing model"]);
  assert.deepEqual(errors({ provider: "cls", model: "claude-sonnet-5-5", effort: 3 }), ["autoModeClassifier.stage1: effort must be a string"]);
  assert.deepEqual(errors("claude-sonnet-5-5"), [`autoModeClassifier.stage1 must be an object or "native"`]);
  assert.deepEqual(errors("native"), []);
  const ingressOnly = { ...providers, cls: { type: "anthropic" as const, auth: "claude-code" as const } };
  assert.deepEqual(validate({ ...DEFAULTS, providers: ingressOnly, autoModeClassifier: { ...main, stage1: { provider: "cls", model: "claude-sonnet-5-5" } } }), ["autoModeClassifier.stage1: provider is ingress-only"]);
});

test("validate lets either side of the Auto mode classifier stay on ordinary routing, but not both", () => {
  const providers = { p: { type: "chatgpt" as const } };
  const check = (settings: unknown) => validate({ ...DEFAULTS, providers, autoModeClassifier: settings as NonNullable<Config["autoModeClassifier"]> });
  assert.deepEqual(check({ stage1: { provider: "p", model: "gpt-6-luna" } }), [], "the first stage alone");
  assert.deepEqual(check({ provider: "p", model: "gpt-6-luna", stage1: "native" }), [], "the rest alone");
  assert.deepEqual(check({}), ["autoModeClassifier names no target"]);
  assert.deepEqual(check({ stage1: "native" }), ["autoModeClassifier names no target"]);
  assert.deepEqual(check({ effort: "high", stage1: "native" }), ["autoModeClassifier: unknown provider", "autoModeClassifier: missing model"], "a half-written main target is an error, not a skip");
});

test("validate accepts a web search backend and rejects an unusable one", () => {
  const providers = { p: { type: "chatgpt" as const } };
  assert.deepEqual(validate({ ...DEFAULTS, providers, webSearch: { provider: "p", model: "gpt-5.6-terra" } }), []);
  assert.deepEqual(validate({ ...DEFAULTS, providers, webSearch: { provider: "p", model: "gpt-5.6-terra", maxResults: 3 } }), []);
  const bad = (webSearch: unknown) => validate({ ...DEFAULTS, providers, webSearch: webSearch as NonNullable<Config["webSearch"]> }).join();
  assert.match(bad({ provider: "missing", model: "m" }), /unknown provider/);
  assert.match(bad({ provider: "", model: "m" }), /missing provider/);
  assert.match(bad({ provider: "p", model: " " }), /missing model/);
  assert.match(bad({ provider: "p", model: "m", maxResults: 0 }), /maxResults must be a positive integer/);
  assert.match(bad({ provider: "p", model: "m", maxResults: 2.5 }), /maxResults must be a positive integer/);
  assert.match(bad("p"), /webSearch must be an object/);
});

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
  // `limits` is carried by every provider kind, so a wrong type is refused once for all of them.
  assert.deepEqual(validate({ ...DEFAULTS, providers: { ok: { type: "anthropic", auth: "claude-code", limits: false } } }), []);
  assert.ok(validate({ ...DEFAULTS, providers: { bad: { type: "anthropic", auth: "claude-code", limits: "no" as unknown as boolean } } }).some((error) => error.includes("limits must be true or false")));
  assert.ok(validate({ ...DEFAULTS, providers: { bad: { type: "chatgpt", limits: 1 as unknown as boolean } } }).some((error) => error.includes("limits must be true or false")));
});

test("every provider kind takes a display label, and a blank or overlong one is refused", () => {
  const providers: Record<string, Provider> = {
    hive: { type: "anthropic-compatible", url: "https://api.example.test", label: "하이브" },
    gpt: { type: "chatgpt", label: "Codex" },
    openrouter: { type: "openai-compatible", url: "https://openrouter.ai/api/v1", label: "OpenRouter" },
    gemini: { type: "google", auth: "api-key", label: "Gemini" },
    claude: { type: "anthropic", auth: "api-key", label: "Claude" },
    grok: { type: "grok", label: "Grok" },
  };
  assert.deepEqual(validate({ ...DEFAULTS, providers }), []);
  for (const [name, p] of Object.entries(providers)) {
    for (const label of ["", "   ", 7, "x".repeat(61)]) {
      const errors = validate({ ...DEFAULTS, providers: { ...providers, [name]: { ...p, label: label as string } } });
      assert.ok(errors.some((error) => error.includes(`provider ${name}: label must be a non-empty string of at most 60 characters`)), `${name} accepted ${JSON.stringify(label)}`);
    }
    // Exactly 60 characters, and no label at all, are both fine.
    assert.deepEqual(validate({ ...DEFAULTS, providers: { ...providers, [name]: { ...p, label: "가".repeat(60) } } }), []);
    const { label: _label, ...unlabelled } = p as Provider & { label?: string };
    assert.deepEqual(validate({ ...DEFAULTS, providers: { ...providers, [name]: unlabelled as Provider } }), []);
  }
});

test("validate accepts a chatgpt provider's Fast switches and refuses a fast that is not an object", () => {
  assert.deepEqual(validate({ ...DEFAULTS, providers: { gpt: { type: "chatgpt", fast: { main: true, subagent: false } } } }), []);
  assert.deepEqual(validate({ ...DEFAULTS, providers: { gpt: { type: "chatgpt", fast: {} } } }), []);
  assert.ok(validate({ ...DEFAULTS, providers: { gpt: { type: "chatgpt", fast: "yes" as unknown as { main: boolean } } } }).some((error) => error.includes("fast must be an object")));
});

test("a Fast switch that is not a boolean reads as off", () => {
  assert.deepEqual(fastSwitches({ fast: { main: true, subagent: true } }), { main: true, subagent: true });
  assert.deepEqual(fastSwitches({ fast: { main: false } }), { main: false, subagent: false });
  assert.deepEqual(fastSwitches({ fast: {} }), { main: false, subagent: false });
  assert.deepEqual(fastSwitches(undefined), { main: false, subagent: false });
  // A hand-edited file can hold anything: a value that is not `true` is off, never "on".
  assert.deepEqual(fastSwitches({ fast: { main: "yes" as unknown as boolean, subagent: 1 as unknown as boolean } }), { main: false, subagent: false });
  assert.deepEqual(fastSwitches({ fast: null as unknown as { main: boolean } }), { main: false, subagent: false });
  assert.deepEqual(fastSwitches({ fast: "yes" as unknown as { main: boolean } }), { main: false, subagent: false });
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

// A model on Google's own wire needs the google adapter, which is an ordinary `google` provider.
// The key lives in the provider's headers (one copy to rotate) and moves to `apiKey` on this wire,
// whose credential header is `x-goog-api-key`; every other vendor header travels along.
test("a google-wire model folds into a google api-key provider, key taken from the provider's headers", () => {
  const provider: OpenAiCompatibleProvider = {
    type: "openai-compatible",
    url: "https://opencode.ai/zen/go/v1",
    preset: "opencode-go",
    sessionHeader: "x-opencode-session",
    headers: { authorization: "Bearer sk-test", "x-extra": "kept" },
    identity: false,
    instructionsAppend: "be brief",
    limits: true,
    models: [
      { id: "gemini-4-argon-contributor", wire: "google", url: "https://opencode.ai/inference/go/google" },
      { id: "gpt-5.6-luna" },
    ],
  };
  const folded = providerFor(provider, "gemini-4-argon-contributor") as GoogleProvider;
  assert.equal(folded.type, "google");
  assert.equal(folded.auth, "api-key");
  assert.equal(folded.apiKey, "sk-test");
  assert.equal(folded.url, "https://opencode.ai/inference/go/google");
  assert.equal(folded.sessionHeader, "x-opencode-session");
  assert.deepEqual(folded.headers, { "x-extra": "kept" }, "the key is not restated in the provider headers");
  assert.equal(folded.identity, false);
  assert.equal(folded.instructionsAppend, "be brief");
  assert.equal(folded.limits, true);
  assert.equal(folded.preset, "opencode-go");
  assert.equal(folded.models, provider.models);

  // The other convention in use is recognised too.
  const xKey = providerFor({ ...provider, headers: { "x-api-key": "sk-x", "x-extra": "kept" } }, "gemini-4-argon-contributor") as GoogleProvider;
  assert.equal(xKey.apiKey, "sk-x");
  assert.equal(providerFor(provider, "gpt-5.6-luna"), provider, "a model with no override is still the provider itself");
});

test("validate accepts a google-wire model and a google provider's sessionHeader/headers", () => {
  assert.deepEqual(validate({
    ...DEFAULTS,
    providers: {
      go: {
        type: "openai-compatible", url: "https://opencode.ai/zen/go/v1", sessionHeader: "x-opencode-session",
        headers: { authorization: "Bearer k" },
        models: [{ id: "gemini-4-argon-contributor", wire: "google", url: "https://opencode.ai/inference/go/google" }],
      },
      gem: { type: "google", auth: "api-key", apiKey: "g", url: "https://opencode.ai/inference/go/google", sessionHeader: "x-opencode-session", headers: { "x-extra": "y" } },
    },
  }), []);
  const bad = validate({
    ...DEFAULTS,
    providers: {
      gem: { type: "google", auth: "api-key", headers: { "x-extra": 1 as unknown as string } },
      go: { type: "openai-compatible", url: "https://example.test", models: [{ id: "m", wire: "gemini" as "google" }] },
    },
  });
  assert.ok(bad.some((error) => error.includes("headers must be a string record")));
  assert.ok(bad.some((error) => error.includes("wire (\"chat\"")), "an unknown wire is refused by the models shape");
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

test("validate accepts a grok provider and refuses a model that would leave its session headers behind", () => {
  const ok = validate({ ...DEFAULTS, providers: { grok: { type: "grok", models: [{ id: "grok-4.7", name: "Grok 4.7", contextWindow: 256000, effortLevels: ["low", "high"] }] } } });
  assert.deepEqual(ok, []);
  assert.deepEqual(validate({ ...DEFAULTS, providers: { grok: { type: "grok", home: "/tmp/g", cli: "/tmp/g/bin/grok", clientVersion: "1.0.46", url: "https://cli-chat-proxy.grok.com/v1" } } }), []);
  const rewired = validate({ ...DEFAULTS, providers: { grok: { type: "grok", models: [{ id: "grok-4.7", wire: "responses" }] } } });
  assert.ok(rewired.some((e) => e.includes("cannot set wire, url or authHeader")));
  assert.ok(validate({ ...DEFAULTS, providers: { grok: { type: "grok", url: "cli-chat-proxy.grok.com" } } }).some((e) => e.includes("url must start")));
  assert.ok(validate({ ...DEFAULTS, providers: { grok: { type: "grok", home: "" } } }).some((e) => e.includes("home must be a non-empty string")));
  // clientVersion goes out as a header value.
  assert.ok(validate({ ...DEFAULTS, providers: { grok: { type: "grok", clientVersion: "1.0.46\nx-evil: 1" } } }).some((e) => e.includes("clientVersion cannot be sent as a header")));
  assert.ok(validate({ ...DEFAULTS, providers: { grok: { type: "grok", clientVersion: "버전1" } } }).some((e) => e.includes("clientVersion cannot be sent as a header")));
  assert.ok(validate({ ...DEFAULTS, providers: { grok: { type: "grok", clientVersion: "1.0.46\u0000" } } }).some((e) => e.includes("clientVersion cannot be sent as a header")));
  // A grok model with no overrides is its own provider: providerFor hands it back unchanged.
  const provider = { type: "grok" as const, models: [{ id: "grok-4.7" }] };
  assert.equal(providerFor(provider, "grok-4.7"), provider);
});
