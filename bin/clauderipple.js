#!/usr/bin/env node
// The published entry point. An npm install carries the JavaScript built from the TypeScript
// sources, because Node refuses to strip types under node_modules; a checkout has no dist/ and
// runs the sources directly. Whichever exists is the CLI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(root, "dist", "cli", "src", "index.js");
const entry = fs.existsSync(built) ? built : path.join(root, "packages", "cli", "src", "index.ts");
await import(pathToFileURL(entry).href);
