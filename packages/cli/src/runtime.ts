// One runtime contract for the CLI, router supervisor, app shell, and hooks.
// Packaged apps execute TypeScript with Electron's bundled Node in type-stripping mode;
// development keeps using the Node executable that started the CLI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Runtime = {
  node: string;
  env: Record<string, string>;
  cli: string;
  router: string;
  hookScript: string;
  repo: string;
  /** The tray's entry point, which differs between a packaged app, an npm install and a checkout. */
  trayMain: string;
  packaged: boolean;
};

function appBundlePath(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(.*\.app)\/Contents(?:\/|$)/);
  return match?.[1] ?? null;
}

export function runtime(): Runtime {
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const bundle = appBundlePath(electronProcess.resourcesPath) ?? appBundlePath(process.execPath);
  if (bundle) {
    const resources = path.join(bundle, "Contents", "Resources", "clauderipple");
    return {
      node: path.join(bundle, "Contents", "MacOS", path.basename(bundle, ".app")),
      env: { ELECTRON_RUN_AS_NODE: "1" },
      cli: path.join(resources, "packages", "cli", "src", "index.ts"),
      router: path.join(resources, "packages", "router", "src", "index.ts"),
      hookScript: path.join(resources, "packages", "cli", "src", "hooks", "agent-title.ts"),
      repo: resources,
      trayMain: "",
      packaged: true,
    };
  }

  // Windows (and any non-macOS electron-builder layout): the sources sit in resources/clauderipple
  // next to app.asar, and the app's own executable runs them with ELECTRON_RUN_AS_NODE.
  const resourcesPath = electronProcess.resourcesPath;
  if (resourcesPath && fs.existsSync(path.join(resourcesPath, "clauderipple", "packages", "router", "src", "index.ts"))) {
    const resources = path.join(resourcesPath, "clauderipple");
    return {
      node: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      cli: path.join(resources, "packages", "cli", "src", "index.ts"),
      router: path.join(resources, "packages", "router", "src", "index.ts"),
      hookScript: path.join(resources, "packages", "cli", "src", "hooks", "agent-title.ts"),
      repo: resources,
      trayMain: "",
      packaged: true,
    };
  }

  // Development runs the .ts sources from the checkout; an npm install runs the .js built from
  // them, in the same shape one level down (dist/cli/src instead of packages/cli/src). This
  // module's own file answers both: its extension says which, and the rest is the same relative
  // walk, so `repo` is the checkout root or the installed package root without a special case.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = path.extname(fileURLToPath(import.meta.url));
  const cli = path.join(here, `index${ext}`);
  return {
    node: process.execPath,
    env: {},
    cli,
    router: path.resolve(here, `../../router/src/index${ext}`),
    hookScript: path.resolve(here, `hooks/agent-title${ext}`),
    repo: path.resolve(here, "../../.."),
    trayMain: path.resolve(here, "../../..", ext === ".ts" ? "packages/app/dist/main.js" : "dist/app/dist/main.js"),
    packaged: false,
  };
}
