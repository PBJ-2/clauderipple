// VERSION is the only version the running code can see; the manifests are what the release is
// named after. They must agree, or an update installs a router that still reports the old number.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/version.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("VERSION matches every package manifest", () => {
  for (const manifest of ["package.json", "packages/router/package.json", "packages/cli/package.json", "packages/app/package.json"]) {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, manifest), "utf8")) as { version: string };
    assert.equal(version, VERSION, `${manifest} says ${version}, src/version.ts says ${VERSION}`);
  }
});
