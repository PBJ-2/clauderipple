// The published package is JavaScript: Node refuses to strip types for anything under
// node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so shipping the .ts sources that
// serve development and the packaged app would install a command that cannot run.
//
// Layout produced here, mirroring the source tree one level up so every relative path in the
// code keeps its meaning:
//
//   dist/cli/src/index.js        the CLI, and with it the supervisor and installer
//   dist/router/src/index.js     the router
//   dist/ui/                     the dashboard, served by the router's admin API
//   dist/app/dist/main.js        the tray, with dist/app/assets next to it as it expects
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

fs.rmSync(dist, { recursive: true, force: true });
execFileSync(npm, ["exec", "--", "tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
execFileSync(npm, ["--workspace", "@clauderipple/app", "run", "build"], { cwd: root, stdio: "inherit" });

fs.cpSync(path.join(root, "packages", "ui"), path.join(dist, "ui"), { recursive: true });
fs.cpSync(path.join(root, "packages", "app", "dist"), path.join(dist, "app", "dist"), { recursive: true });
fs.cpSync(path.join(root, "packages", "app", "assets"), path.join(dist, "app", "assets"), { recursive: true });
// The tray is compiled to CommonJS, but the package root says "type": "module", and the nearest
// package.json decides: without this one Electron loaded main.js as an ES module and died with
// "exports is not defined in ES module scope" (issue #8, Windows, 0.3.1). In a checkout
// packages/app has its own package.json, which is why development never showed it.
fs.writeFileSync(path.join(dist, "app", "package.json"), JSON.stringify({ private: true, type: "commonjs" }, null, 2) + "\n");

const entry = path.join(dist, "cli", "src", "index.js");
if (!fs.existsSync(entry)) throw new Error(`build produced no CLI entry point at ${entry}`);
console.log(`✓ built ${path.relative(root, entry)}`);
