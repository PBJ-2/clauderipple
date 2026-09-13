// One runtime contract for the CLI, router supervisor, app shell, and hooks.
// Packaged apps execute TypeScript with Electron's bundled Node in type-stripping mode;
// development keeps using the Node executable that started the CLI.

import path from "node:path";

export type Runtime = {
  node: string;
  env: Record<string, string>;
  cli: string;
  router: string;
  hookScript: string;
  repo: string;
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
      packaged: true,
    };
  }

  const cli = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), "index.ts");
  return {
    node: process.execPath,
    env: {},
    cli,
    router: path.resolve(path.dirname(cli), "../../router/src/index.ts"),
    hookScript: path.resolve(path.dirname(cli), "hooks/agent-title.ts"),
    repo: path.resolve(path.dirname(cli), "../../.."),
    packaged: false,
  };
}
