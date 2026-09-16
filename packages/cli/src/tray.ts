// The menu-bar / tray app, started from the CLI.
//
// Installed from npm there is no application bundle to double-click. Electron supplies the tray,
// and npm fetches the binary already built for this platform — but it is 270MB, which is not
// something to hand every person who only wants the router. So it is not a dependency: the tray
// command fetches it on request, once. Inside a packaged app the bundle is the Electron binary,
// so the same command simply relaunches it.

import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runtime } from "./runtime.ts";

/** Electron version to fetch on request. Kept in step with the one the app is developed against. */
const ELECTRON_RANGE = "^38.1.0";

/** The Electron executable installed alongside us, or null when the optional dependency is absent. */
export function electronPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // The electron package exports the path to its binary as its module value.
    const value = require("electron") as unknown;
    return typeof value === "string" && fs.existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

export type TrayStart = { ok: boolean; message: string };

/**
 * Starts the tray and returns immediately. `detached` outlives this process, which is what a
 * command typed in a terminal wants; the supervisor uses the foreground form instead.
 */
export function startTray(options: { detached?: boolean } = {}): TrayStart {
  const current = runtime();
  if (current.packaged) {
    // The packaged app IS the tray: relaunching its own binary with no script is what opens it.
    const child = spawn(current.node, [], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, message: "✓ tray started" };
  }
  const electron = electronPath();
  if (!electron) {
    return {
      ok: false,
      message: "the tray needs Electron, which is about 270MB and is not installed by default.\nFetch it once with: clauderipple tray --install",
    };
  }
  const main = current.trayMain;
  if (!fs.existsSync(main)) {
    return { ok: false, message: `the tray is not built: ${main} is missing (run: npm run build)` };
  }
  const child = spawn(electron, [main], {
    detached: options.detached ?? true,
    stdio: "ignore",
    // Electron would otherwise re-enter as a plain Node process, since that is how the CLI runs.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  if (options.detached ?? true) child.unref();
  return { ok: true, message: "✓ tray started" };
}

/** The npm that came with the Node running us, as a script we can hand to that same Node. */
function npmCli(): string | null {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Fetches Electron into this installation so the tray can run. Prints npm's own progress. */
export function installTrayRuntime(): TrayStart {
  if (electronPath()) return { ok: true, message: "✓ Electron is already installed" };
  const cli = npmCli();
  if (!cli) return { ok: false, message: `found no npm next to ${process.execPath}; install Electron yourself: npm install electron` };
  const target = runtime().repo;
  const result = spawnSync(process.execPath, [cli, "install", "--no-save", "--loglevel", "error", `electron@${ELECTRON_RANGE}`], {
    cwd: target,
    stdio: "inherit",
  });
  if (result.status !== 0) return { ok: false, message: `npm could not install Electron into ${target}` };
  return electronPath()
    ? { ok: true, message: "✓ Electron installed — start the tray with: clauderipple tray" }
    : { ok: false, message: `npm reported success but Electron is still not resolvable from ${target}` };
}
