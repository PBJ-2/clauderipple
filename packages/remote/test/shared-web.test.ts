import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED } from "../src/server.ts";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Value imports only: an `import type` is erased and the browser never asks for it. */
function valueImports(file: string, pattern: RegExp): string[] {
  const source = fs.readFileSync(file, "utf8");
  return [...source.matchAll(pattern)].filter(m => !/^import\s+type\b/.test(m[0])).map(m => m[1]!);
}

test("every src module the web page loads is in SHARED, so the installed package and the relay serve it (#174)", () => {
  const wanted = new Set<string>();
  const web = path.join(pkg, "web");
  for (const name of fs.readdirSync(web).filter(n => n.endsWith(".ts"))) {
    for (const rel of valueImports(path.join(web, name), /import[^;]*?from\s+"\.\.\/src\/([^"]+)"/g)) wanted.add(`src/${rel}`);
  }
  // A shared module's own value imports are fetched by the browser too.
  for (const rel of [...wanted]) {
    for (const dep of valueImports(path.join(pkg, rel), /import[^;]*?from\s+"\.\/([^"]+)"/g)) wanted.add(`src/${dep}`);
  }
  assert.ok(wanted.size > 0);
  for (const rel of wanted) assert.ok(rel in SHARED, `${rel} is imported by the web page but not served`);
});
