import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, DEFAULTS, validate } from "../src/config.ts";
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
