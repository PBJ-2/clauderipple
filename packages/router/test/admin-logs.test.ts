import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAdmin } from "../src/admin.ts";
import { DEFAULTS } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";

const BLOCK_SIZE = 64 * 1024;

// The previous whole-file algorithm is the byte-for-byte response reference.
function oldTail(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length ? "\n" : "");
}

async function withLogs(fn: (file: string, read: (n?: string | number) => Promise<string>) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-admin-logs-"));
  const previousHome = process.env.CLAUDERIPPLE_HOME;
  process.env.CLAUDERIPPLE_HOME = home;
  let admin: Awaited<ReturnType<typeof startAdmin>> | undefined;
  try {
    const config = { ...DEFAULTS, admin: { port: 0 } };
    const file = path.join(home, "logs", "router.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    admin = await startAdmin({
      config: () => config,
      configFile: path.join(home, "config.json"),
      log: new Logger(null, 1_000_000, 1, false),
      stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
      health: () => 0,
      version: "0.0.0-test",
      requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
      claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
    });
    const endpoint = `http://127.0.0.1:${admin.port}/api/logs`;
    await fn(file, async (n) => {
      const response = await fetch(n === undefined ? endpoint : `${endpoint}?n=${encodeURIComponent(n)}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      return response.text();
    });
  } finally {
    admin?.close();
    if (previousHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const [requested, expected] of [[-1, 1], [100000, 2000]] as const) {
  test(`/api/logs clamps n=${requested} to ${expected}`, async () => {
    await withLogs(async (file, read) => {
      const text = Array.from({ length: 2100 }, (_, i) => `line ${i}\n`).join("");
      fs.writeFileSync(file, text);
      assert.equal(await read(requested), oldTail(text, expected));
    });
  });
}

test("/api/logs defaults invalid n and bounds zero and fractional counts", async () => {
  await withLogs(async (file, read) => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join("");
    fs.writeFileSync(file, text);
    for (const n of [undefined, "invalid", "Infinity", "NaN"]) assert.equal(await read(n), oldTail(text, 200));
    for (const n of [0, "", 1.9]) assert.equal(await read(n), oldTail(text, 1));
  });
});

test("/api/logs returns exactly the last n lines across blocks without reading the whole file", async (t) => {
  await withLogs(async (file, read) => {
    const text = Array.from({ length: 12000 }, (_, i) => `line ${i}: ${"x".repeat(80)}\n`).join("");
    fs.writeFileSync(file, text);
    let bytesRead = 0;
    const original = fs.readSync;
    const spy = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
      const bytes = original(...args);
      bytesRead += bytes;
      return bytes;
    });
    assert.equal(await read(200), oldTail(text, 200));
    assert.ok(bytesRead > 0 && bytesRead <= BLOCK_SIZE, `read ${bytesRead} bytes`);
    spy.mock.restore();
    assert.equal(await read(2000), oldTail(text, 2000));
  });
});

test("/api/logs joins blocks before decoding a split multi-byte UTF-8 character", async () => {
  await withLogs(async (file, read) => {
    // The last block starts at the second byte of the four-byte character.
    const text = `prefix\n${"a".repeat(BLOCK_SIZE)}🌍${"b".repeat(BLOCK_SIZE - 3)}`;
    fs.writeFileSync(file, text);
    assert.equal(await read(1), oldTail(text, 1));
    assert.equal(await read(2), oldTail(text, 2));
  });
});

test("/api/logs preserves short, empty, missing, CRLF and unterminated files", async () => {
  await withLogs(async (file, read) => {
    assert.equal(await read(200), "");
    for (const text of ["", "\n", "\n\n", "one", "one\ntwo", "one\ntwo\n", "one\r\ntwo\r\n", "one\r\ntwo\r", "one\n\n"]) {
      fs.writeFileSync(file, text);
      for (const n of [1, 2, 200]) assert.equal(await read(n), oldTail(text, n), JSON.stringify({ text, n }));
    }
  });
});

test("/api/logs matches the old algorithm on deterministic randomized content", async () => {
  await withLogs(async (file, read) => {
    let seed = 0x12345678;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const chars = ["a", "é", "界", "🌍", "\r", " "];
    for (let sample = 0; sample < 40; sample++) {
      const lines = Array.from({ length: random(2500) + 1 }, () => {
        const word = Array.from({ length: random(16) }, () => chars[random(chars.length)]).join("");
        return word.repeat(random(12));
      });
      const text = lines.join("\n") + (random(2) ? "\n" : "");
      fs.writeFileSync(file, text);
      for (const n of [1, random(2000) + 1, 2000]) {
        assert.equal(await read(n), oldTail(text, n), `sample ${sample}, n=${n}`);
      }
    }
  });
});
