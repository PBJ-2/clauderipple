// The menu-bar / tray app, started from the CLI.
//
// Installed from npm there is no application bundle to double-click: Electron arrives as an
// optional dependency, already built for this platform, and this module runs the tray's own
// entry point with it. Inside a packaged app the bundle is the Electron binary, so the same
// command simply relaunches it.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";

import { runtime } from "./runtime.ts";

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
      message: "the tray needs Electron, which is an optional dependency — install it with: npm install -g electron",
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
