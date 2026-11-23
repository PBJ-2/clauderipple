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
//   dist/mod/                    the status mod, a plugin folder Claude Code loads
//   dist/app/dist/main.js        the tray, with dist/app/assets (tray and app icons) next to it as it expects
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
/** @param {NodeJS.Platform} platform @param {typeof execFileSync} run */
export function npmBuildSteps(platform = process.platform, run = execFileSync) {
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  // .cmd is not a PE executable; Windows needs cmd.exe to interpret npm's shim.
  const options = { cwd: root, stdio: "inherit", shell: platform === "win32" };
  run(npm, ["exec", "--", "tsc", "-p", "tsconfig.build.json"], options);
  run(npm, ["--workspace", "@clauderipple/app", "run", "build"], options);
}

async function build() {
  fs.rmSync(dist, { recursive: true, force: true });
  npmBuildSteps();

  fs.cpSync(path.join(root, "packages", "ui"), path.join(dist, "ui"), { recursive: true });
  // Host runtime metadata and browser modules are not TypeScript server compilation outputs.
  fs.copyFileSync(path.join(root, "packages", "remote", "package.json"), path.join(dist, "remote", "package.json"));
  const remoteWeb = path.join(root, "packages", "remote", "web");
  if (fs.existsSync(remoteWeb)) fs.cpSync(remoteWeb, path.join(dist, "remote", "web"), { recursive: true });
  // SHARED keeps .ts browser URLs in both checkout and installed host layouts. The list is SHARED's own:
  // a hand-kept copy here missed chunks.ts and wrap-up.ts, and the installed web page stayed blank (#174).
  const { SHARED } = await import("../packages/remote/src/server.ts");
  for (const rel of Object.keys(SHARED).filter(rel => rel.startsWith("src/"))) {
    fs.copyFileSync(path.join(root, "packages", "remote", rel), path.join(dist, "remote", rel));
  }
  // The status mod is loaded by Claude Code itself, as TypeScript; the API types it writes beside the
  // manifest when it loads one are its own and are left out, as is the design preview (a dev tool).
  fs.cpSync(path.join(root, "packages", "mod"), path.join(dist, "mod"), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.claude-plugin${path.sep}types`) && !source.includes(`${path.sep}mod${path.sep}preview`),
  });
  fs.cpSync(path.join(root, "packages", "app", "dist"), path.join(dist, "app", "dist"), { recursive: true });
  fs.cpSync(path.join(root, "packages", "app", "assets"), path.join(dist, "app", "assets"), { recursive: true });
  // The app icon travels with the tray's assets: `clauderipple app --install` puts it on the launcher
  // it makes (icns on macOS, png on Linux, ico on Windows) and the tray uses it for its window.
  for (const name of ["icon.icns", "icon.png", "icon.ico"]) {
    if (!fs.existsSync(path.join(dist, "app", "assets", name))) throw new Error(`packages/app/assets/${name} is missing; run: npm --workspace @clauderipple/app run icons`);
  }
  // The tray is compiled to CommonJS, but the package root says "type": "module", and the nearest
  // package.json decides: without this one Electron loaded main.js as an ES module and died with
  // "exports is not defined in ES module scope" (issue #8, Windows, 0.3.1). In a checkout
  // packages/app has its own package.json, which is why development never showed it.
  // It carries the version too: Electron's app.getVersion() reads it and, finding none, answers
  // with Electron's own version.
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  fs.writeFileSync(path.join(dist, "app", "package.json"), JSON.stringify({ private: true, version, type: "commonjs" }, null, 2) + "\n");

  const entry = path.join(dist, "cli", "src", "index.js");
  if (!fs.existsSync(entry)) throw new Error(`build produced no CLI entry point at ${entry}`);
  console.log(`✓ built ${path.relative(root, entry)}`);
}

if (import.meta.main) await build();
