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
