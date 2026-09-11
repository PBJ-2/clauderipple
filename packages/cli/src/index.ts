#!/usr/bin/env node
// clauderipple — install / uninstall / status / start / stop / restart / logs / config
//
// install:   generates the local CA + leaf, writes a starter config, points
//            ~/.claude/settings.json env at the router, registers the launchd agent,
//            then probes the whole chain end to end.
// uninstall: reverses exactly that. Home dir is kept unless --purge.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ConfigStore, DEFAULTS, homeDir, configPath } from "../../router/src/config.ts";
import { certsExist, certPaths, generateCerts } from "./certs.ts";
import { applyProxyEnv, currentProxyEnv, removeProxyEnv, settingsPath } from "./settings.ts";
import { agentState, installAgent, kickstart, plistPath, removeAgent, stopAgent } from "./launchd.ts";
import { BUNDLE_ID, removeBundle, writeBundle } from "./bundle.ts";

const VERSION = "0.1.0";
import { probe } from "./probe.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const routerScript = path.resolve(here, "../../router/src/index.ts");

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === `--${name}` || a === `-${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The router needs a moment to come up under launchd; probe a few times before declaring failure. */
async function probeWithRetry(o: Parameters<typeof probe>[0], attempts = 8, delayMs = 750): Promise<Awaited<ReturnType<typeof probe>>> {
  let last = await probe(o);
  for (let i = 1; i < attempts && !last.ok; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await probe(o);
  }
  return last;
}

function starterConfig(port: number): string {
  return JSON.stringify(
    {
      $docs: "https://github.com/pbj/clauderipple/blob/main/docs/ARCHITECTURE.md",
      listen: { host: "127.0.0.1", port },
      upstream: DEFAULTS.upstream,
      providers: {},
      routes: {},
      direct: [],
      aliases: {},
      effortClamp: DEFAULTS.effortClamp,
      cli: { extraModels: [] },
      health: DEFAULTS.health,
      log: DEFAULTS.log,
    },
    null,
    2,
  ) + "\n";
}

function proxyUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function install(): Promise<void> {
  const home = homeDir();
  const port = Number(opt("port") ?? DEFAULTS.listen.port);
  if (process.platform !== "darwin") throw new Error("install currently supports macOS only (launchd). Run the router manually on other platforms.");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  if (!certsExist(home)) {
    generateCerts(home, DEFAULTS.upstream);
    console.log(`✓ certificates generated in ${home} (not installed in any keychain)`);
  } else console.log("✓ certificates already present");

  if (!fs.existsSync(configPath())) {
    fs.writeFileSync(configPath(), starterConfig(port));
    console.log(`✓ starter config written: ${configPath()}`);
  } else console.log(`✓ config kept: ${configPath()}`);

  const cfg = new ConfigStore(configPath()).get();
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const caPath = certPaths(home).caPem;
  const maxCtx = opt("max-context-tokens");
  const edit = applyProxyEnv({ proxyUrl, caPath, force: flag("force"), ...(maxCtx ? { maxContextTokens: Number(maxCtx) } : {}) });
  console.log(edit.changed ? `✓ ${settingsPath()} updated (backup: ${edit.backup ?? "none"})` : `✓ ${settingsPath()} already correct`);
  for (const n of edit.notes) console.log(`  note: ${n}`);

  const launcher = writeBundle({ home, node: process.execPath, script: routerScript, version: VERSION });
  console.log(`✓ background item bundle written: ${path.dirname(path.dirname(path.dirname(launcher)))} (shows as "ClaudeRipple" in Login Items)`);
  const plist = installAgent({ launcher, bundleId: BUNDLE_ID, home });
  console.log(`✓ launchd agent registered: ${plist}`);

  const p = await probeWithRetry({ host: cfg.listen.host, port: cfg.listen.port, caPem: caPath, upstream: cfg.upstream });
  console.log(p.ok ? `✓ end-to-end probe passed (${p.detail}, ${p.ms}ms)` : `✗ probe failed: ${p.detail}`);
  if (!p.ok) process.exitCode = 1;
  else console.log("\nDone. New Claude Desktop Code sessions go through ClaudeRipple. Existing sessions pick up settings.json env changes on their next request.");
}

function uninstall(): void {
  const home = homeDir();
  const cfg = new ConfigStore(configPath()).get();
  const removed = removeAgent();
  console.log(removed ? `✓ launchd agent removed (${plistPath()})` : "✓ no launchd agent registered");
  removeBundle(home);
  const edit = removeProxyEnv({ proxyUrl: proxyUrlFor(cfg.listen.port), caPath: certPaths(home).caPem });
  console.log(edit.changed ? `✓ ${settingsPath()} restored (backup: ${edit.backup ?? "none"})` : `✓ ${settingsPath()} had no ClaudeRipple keys`);
  for (const n of edit.notes) console.log(`  note: ${n}`);
  if (flag("purge")) {
    fs.rmSync(home, { recursive: true, force: true });
    console.log(`✓ removed ${home}`);
  } else console.log(`  kept ${home} (config, certs, logs). Add --purge to delete it.`);
}

async function status(): Promise<void> {
  const home = homeDir();
  const cfg = new ConfigStore(configPath()).get();
  const env = currentProxyEnv();
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const caPath = certPaths(home).caPem;
  const rows: [string, string][] = [];
  rows.push(["home", home]);
  rows.push(["config", fs.existsSync(configPath()) ? `${Object.keys(cfg.routes).length} routes, ${Object.keys(cfg.providers).length} providers, direct=${cfg.direct.map((d) => d.prefix).join(",") || "-"}` : "missing"]);
  rows.push(["certs", certsExist(home) ? "present" : "missing"]);
  rows.push(["settings.json", env.HTTPS_PROXY === proxyUrl && env.NODE_EXTRA_CA_CERTS === caPath ? "points at ClaudeRipple" : `HTTPS_PROXY=${env.HTTPS_PROXY ?? "-"} NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS ?? "-"}`]);
  rows.push(["launchd", agentState()]);
  const p = await probe({ host: cfg.listen.host, port: cfg.listen.port, caPem: caPath, upstream: cfg.upstream });
  rows.push(["probe", `${p.ok ? "ok" : "FAIL"}: ${p.detail} (${p.ms}ms)`]);
  for (const [name, p2] of Object.entries(cfg.providers)) {
    const u = new URL(p2.url);
    rows.push([`provider ${name}`, await tcpCheck(u.hostname, Number(u.port) || (u.protocol === "https:" ? 443 : 80))]);
  }
  rows.push(["claude code cli", cliVersions()]);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
  if (!p.ok) process.exitCode = 1;
}

function tcpCheck(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve("timeout");
    }, 2000);
    s.once("connect", () => {
      clearTimeout(t);
      s.destroy();
      resolve(`listening on ${host}:${port}`);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      resolve(`DOWN (${(e as NodeJS.ErrnoException).code ?? e.message})`);
    });
  });
}

function cliVersions(): string {
  const dir = path.join(process.env.HOME ?? "", "Library", "Application Support", "Claude", "claude-code");
  try {
    const v = fs.readdirSync(dir).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return v.length ? `${v[v.length - 1]} (${v.length} versions cached; app auto-updates the CLI)` : "none cached";
  } catch {
    return "n/a";
  }
}

function logs(): void {
  const file = path.join(homeDir(), "logs", "router.log");
  if (!fs.existsSync(file)) {
    console.log(`no log yet at ${file}`);
    return;
  }
  const n = Number(opt("n") ?? 50);
  if (flag("f") || args.includes("-f")) {
    execFileSync("tail", ["-n", String(n), "-f", file], { stdio: "inherit" });
  } else {
    execFileSync("tail", ["-n", String(n), file], { stdio: "inherit" });
  }
}

function help(): void {
  console.log(`clauderipple <command>

  install [--port N] [--force] [--max-context-tokens N]
  uninstall [--purge]
  status
  start | stop | restart
  logs [-n N] [-f]
  config            print the config file path

Home directory: ${homeDir()}  (override with CLAUDERIPPLE_HOME)`);
}

try {
  switch (cmd) {
    case "install":
      await install();
      break;
    case "uninstall":
      uninstall();
      break;
    case "status":
      await status();
      break;
    case "start":
      console.log(kickstart() ? "started" : "start failed (is it installed?)");
      break;
    case "restart":
      console.log(kickstart() ? "restarted" : "restart failed (is it installed?)");
      break;
    case "stop":
      console.log(stopAgent() ? "stopped (run `clauderipple start` or `install` to bring it back)" : "stop failed (not loaded?)");
      break;
    case "logs":
      logs();
      break;
    case "config":
      console.log(configPath());
      break;
    default:
      help();
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
