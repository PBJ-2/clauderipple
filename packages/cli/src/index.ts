#!/usr/bin/env node
// clauderipple — install / uninstall / status / start / stop / restart / logs / config
//
// install:   generates the local CA + leaf, writes a starter config, registers the supervisor
//            (launchd / Task Scheduler / systemd), probes the whole chain end to end, and only
//            then points ~/.claude/settings.json env at the router.
// uninstall: reverses exactly that. Home dir is kept unless --purge.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ConfigStore, DEFAULTS, homeDir, configPath } from "../../router/src/config.ts";
import { adminPort } from "../../router/src/admin.ts";
import { certsExist, certPaths, generateCerts } from "./certs.ts";
import { applyProxyEnv, checkProxyEnv, currentProxyEnv, removeProxyEnv, settingsPath } from "./settings.ts";
import { agentDefinitionPath, agentState, installAgent, isLinux, isSupported, isWindows, removeAgent, restartAgent, startAgent, stopAgent, supervisorName } from "./supervisor.ts";
import { BUNDLE_ID, removeBundle, writeBundle } from "./bundle.ts";
import { applyAppProxy, caTrusted, currentAppProxy, removeAppProxy, trustCa, untrustCa } from "./picker.ts";
import { runtime } from "./runtime.ts";
import { codexOff, codexOn } from "./codex.ts";
import { ingressModels } from "../../router/src/ingress/models.ts";
import { claudeLogin, claudeLogout, desktopClaudeCodeDirs } from "./claude-auth.ts";
import { openBrowser } from "./browser.ts";
import { installTrayRuntime, startTray } from "./tray.ts";
import { ClaudeOAuthSession } from "../../router/src/providers/claude-oauth.ts";

function setPickerEnabled(enabled: boolean): void {
  const file = configPath();
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.picker = { ...((raw.picker as Record<string, unknown> | undefined) ?? {}), enabled };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

async function pickerOn(): Promise<void> {
  const home = homeDir();
  const cfg = new ConfigStore(configPath()).get();
  const caPem = certPaths(home).caPem;
  if (!fs.existsSync(path.join(home, "ca.key"))) throw new Error("ca.key missing; run `clauderipple install` first");
  // Linux has the Config Library (~/.config/Claude-3p, read from Claude Desktop 2.2553.13's bundle)
  // but no CA trust step yet, and without it the app would reject the router's certificate.
  if (isLinux) throw new Error("picker mode is not available on Linux yet. Model mapping works without it; the Desktop picker keeps showing Claude's own names.");
  // With picker mode on, every byte Claude Desktop sends goes through the router (ARCHITECTURE §5):
  // pointing the app at one that is not answering leaves it a blank page, so check first.
  const ready = await probe({ host: cfg.listen.host, port: cfg.listen.port, caPem, upstream: cfg.upstream });
  if (!ready.ok) throw new Error(`the router is not answering (${ready.detail}); picker mode not enabled. Start it with \`clauderipple start\` and try again.`);
  console.log("Picker mode makes Claude Desktop's own claude.ai traffic go through ClaudeRipple so the model picker can list your GPT models.");
  console.log(
    isWindows
      ? "Step 1/3: trusting the ClaudeRipple CA for your Windows user account. Windows will show a confirmation dialog with the certificate fingerprint — answer Yes. No administrator rights are needed."
      : "Step 1/3: trusting the ClaudeRipple CA in your login keychain. macOS will ask for your password (ClaudeRipple never sees it).",
  );
  trustCa(caPem);
  if (!caTrusted()) throw new Error("CA is not trusted; picker mode not enabled");
  console.log(isWindows ? "✓ CA trusted (current user only)" : "✓ CA trusted (login keychain only)");
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const r = applyAppProxy(proxyUrl);
  console.log(`✓ Claude Desktop config library entry applied (${r.id}${r.replaced ? `, previous entry ${r.replaced} remembered` : ""}): egressProxyUrl=${proxyUrl}`);
  setPickerEnabled(true);
  console.log("✓ picker.enabled = true (the router picks it up live; no restart)");
  console.log("\nStep 3/3 is yours: quit and reopen Claude Desktop. The app reads its proxy setting at start.");
  console.log("Then open the Code tab picker: entries from cli.extraModels should be there. `clauderipple status` shows the last injection.");
}

function describeRestart(r: ReturnType<typeof restartAgent>): string {
  if (r === "drained") return "✓ router restarted (in-flight model calls were allowed to finish)";
  if (r === "kickstarted") return "✓ router restarted (hard restart: it did not exit on its own in time)";
  return "  router not restarted (not installed?) — run `clauderipple install`";
}

function pickerOff(): void {
  const home = homeDir();
  const removed = removeAppProxy();
  console.log(removed ? "✓ Claude Desktop config library entry removed (previous entry restored if there was one)" : "✓ no ClaudeRipple config library entry");
  try {
    setPickerEnabled(false);
    console.log("✓ picker.enabled = false");
  } catch {
    /* no config */
  }
  if (isWindows) console.log("Removing the CA: Windows will ask you to confirm once more.");
  const store = isWindows ? "your user certificate store" : "the login keychain";
  console.log(untrustCa(certPaths(home).caPem) ? `✓ CA removed from ${store}` : `✓ CA was not in ${store}`);
  console.log("\nQuit and reopen Claude Desktop to apply.");
}

import { VERSION } from "../../router/src/version.ts";
import { probe } from "./probe.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const installedRuntime = runtime();
const routerScript = installedRuntime.router;

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === `--${name}` || a === `-${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The router needs a moment to come up under launchd; probe a few times before declaring failure. */
async function probeWithRetry(o: Parameters<typeof probe>[0], attempts = 16, delayMs = 750): Promise<Awaited<ReturnType<typeof probe>>> {
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
      $docs: "https://github.com/PBJ-2/clauderipple/blob/main/docs/ARCHITECTURE.md",
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
  if (!isSupported) throw new Error(`install supports macOS, Windows and Linux (systemd); on ${process.platform} run the router manually.`);
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
  // settings.json is written last, after the probe: from that write on, every new Claude Code
  // session sends everything to this router, so it must not point at one that never came up.
  // A foreign proxy is still refused here, before anything is registered.
  checkProxyEnv({ proxyUrl, force: flag("force") });

  // Persist the single execution contract so the GUI, admin API, hooks, and supervisor all use
  // this installation's runtime rather than any Node installation on the user's PATH.
  fs.writeFileSync(
    path.join(home, "paths.json"),
    JSON.stringify(
      {
        node: installedRuntime.node,
        env: installedRuntime.env,
        cli: installedRuntime.cli,
        router: installedRuntime.router,
        hookScript: installedRuntime.hookScript,
        repo: installedRuntime.repo,
      },
      null,
      2,
    ) + "\n",
  );
  // Windows and Linux register node + the router script directly (schtasks.ts writes its own .cmd
  // launcher); a macOS source checkout gets a small .app so the agent shows a real name in Login Items.
  if (installedRuntime.packaged || isWindows || isLinux) {
    const plist = installAgent({
      program: installedRuntime.node,
      args: [installedRuntime.router],
      bundleId: "com.clauderipple.app",
      home,
      env: { ...installedRuntime.env, ...(process.env.CLAUDE_SETTINGS_PATH ? { CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH } : {}) },
    });
    console.log(`✓ ${supervisorName()} registered: ${plist}${isLinux ? "" : ' (shows as "ClaudeRipple" in Login Items)'}`);
  } else {
    const launcher = writeBundle({ home, node: installedRuntime.node, script: installedRuntime.router, version: VERSION });
    console.log(`✓ background item bundle written: ${path.dirname(path.dirname(path.dirname(launcher)))} (shows as "ClaudeRipple" in Login Items)`);
    const plist = installAgent({
      program: launcher,
      bundleId: BUNDLE_ID,
      home,
      ...(process.env.CLAUDE_SETTINGS_PATH ? { env: { CLAUDE_SETTINGS_PATH: process.env.CLAUDE_SETTINGS_PATH } } : {}),
    });
    console.log(`✓ ${supervisorName()} registered: ${plist}`);
  }

  // launchd starts the agent the moment it is bootstrapped (RunAtLoad); a scheduled task waits for
  // its logon trigger, so the router would only appear after the next sign-in. Start it either way.
  const started = startAgent();
  console.log(started === "failed" ? `✗ could not start the router (${supervisorName()})` : `✓ router ${started === "already-running" ? "already running" : "started"}`);

  const p = await probeWithRetry({ host: cfg.listen.host, port: cfg.listen.port, caPem: caPath, upstream: cfg.upstream });
  console.log(p.ok ? `✓ end-to-end probe passed (${p.detail}, ${p.ms}ms)` : `✗ probe failed: ${p.detail}`);
  if (!p.ok) {
    process.exitCode = 1;
    console.log(`${settingsPath()} was left as it was, so Claude Code does not depend on a router that is not answering. Fix the router, then run install again.`);
    return;
  }
  const edit = applyProxyEnv({ proxyUrl, caPath, force: flag("force"), ...(maxCtx ? { maxContextTokens: Number(maxCtx) } : {}), models: cfg.cli.models ?? {} });
  console.log(edit.changed ? `✓ ${settingsPath()} updated (backup: ${edit.backup ?? "none"})` : `✓ ${settingsPath()} already correct`);
  for (const n of edit.notes) console.log(`  note: ${n}`);
  console.log("\nDone. New Claude Desktop Code sessions go through ClaudeRipple. Existing sessions pick up settings.json env changes on their next request.");
}

function uninstall(): void {
  const home = homeDir();
  const cfg = new ConfigStore(configPath()).get();
  // Stop the router before unregistering it. On macOS unloading the agent takes the process with
  // it; on Windows removing the task leaves it running, and a running router holds router.log open,
  // so --purge then fails with EPERM and leaves the home directory behind (measured 2026-09-16 in a
  // Windows 11 arm64 VM).
  if (stopAgent()) console.log("✓ router stopped");
  const removed = removeAgent();
  console.log(removed ? `✓ ${supervisorName()} removed (${agentDefinitionPath()})` : `✓ no ${supervisorName()} registered`);
  removeBundle(home);
  const edit = removeProxyEnv({ proxyUrl: proxyUrlFor(cfg.listen.port), caPath: certPaths(home).caPem });
  console.log(edit.changed ? `✓ ${settingsPath()} restored (backup: ${edit.backup ?? "none"})` : `✓ ${settingsPath()} had no ClaudeRipple keys`);
  for (const n of edit.notes) console.log(`  note: ${n}`);
  if (flag("purge")) {
    // Windows releases a file handle a moment after the process holding it exits; one immediate
    // attempt can still lose the race, so the removal is retried briefly before it is reported.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        const until = Date.now() + 300;
        while (Date.now() < until) { /* the CLI is synchronous here; a short spin is the whole wait */ }
      }
    }
    if (lastError) console.log(`  could not remove ${home}: ${(lastError as Error).message}`);
    else console.log(`✓ removed ${home}`);
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
  rows.push([supervisorName(), agentState()]);
  const ap = currentAppProxy();
  rows.push(["picker mode", cfg.picker?.enabled ? `on · CA ${caTrusted() ? "trusted" : "NOT trusted"} · app proxy ${ap.ours ? ap.egressProxyUrl : "NOT set"}` : `off${ap.ours ? " (app proxy entry still present — run `picker off`)" : ""}`]);
  const p = await probe({ host: cfg.listen.host, port: cfg.listen.port, caPem: caPath, upstream: cfg.upstream });
  rows.push(["probe", `${p.ok ? "ok" : "FAIL"}: ${p.detail} (${p.ms}ms)`]);
  for (const [name, p2] of Object.entries(cfg.providers)) {
    const providerUrl = p2.type === "chatgpt" ? (p2.url ?? "https://chatgpt.com") : p2.type === "anthropic" ? "https://api.anthropic.com" : p2.url;
    const u = new URL(providerUrl);
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
  for (const dir of desktopClaudeCodeDirs()) {
    try {
      const v = fs.readdirSync(dir).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (v.length) return `${v[v.length - 1]} (${v.length} versions cached; app auto-updates the CLI)`;
    } catch {
      // Next root: the app caches under a different AppData directory depending on the platform.
    }
  }
  return "none cached";
}

function ui(): void {
  const cfg = new ConfigStore(configPath()).get();
  const port = adminPort(cfg);
  const url = `http://127.0.0.1:${port}/`;
  if (openBrowser(url)) console.log(`opened ${url}`);
  else console.log(`could not open a browser automatically; open this URL yourself: ${url}`);
}

function logs(): void {
  const file = path.join(homeDir(), "logs", "router.log");
  if (!fs.existsSync(file)) {
    console.log(`no log yet at ${file}`);
    return;
  }
  const n = Number(opt("n") ?? 50);
  const follow = flag("f") || args.includes("-f");
  // No `tail` on Windows, and reimplementing it in Node keeps both platforms on one code path.
  const printLast = (): number => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const tail = lines.slice(Math.max(0, lines.length - n - 1));
    process.stdout.write(tail.join("\n"));
    return fs.statSync(file).size;
  };
  let offset = printLast();
  if (!follow) return;
  fs.watchFile(file, { interval: 500 }, () => {
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      process.stdout.write(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
    offset = size;
  });
}

function help(): void {
  console.log(`clauderipple <command>

  install [--port N] [--force] [--max-context-tokens N]
  uninstall [--purge]
  status
  start | stop | restart
  logs [-n N] [-f]
  config            print the config file path
  ui                open the dashboard in your browser
  tray [--install]  start the menu-bar / tray app (--install fetches Electron, ~270MB, once)
  login             add a ChatGPT account (opens your browser; run again to add another — they take turns when one runs out)
  logout            forget every ChatGPT account added with "login" (the Codex CLI's own login is left alone)
  claude-login      connect a Claude subscription in the browser (--setup-token: via \`claude setup-token\`; --manual: paste the code)
  claude-logout     remove every Claude subscription added to ClaudeRipple
  picker on|off     show your mapped models by name in the Claude Desktop picker (trusts the CA in your login keychain, routes the app through ClaudeRipple)
  codex on|off      add/remove ClaudeRipple's local OpenAI provider and selection profile for Codex CLI
  agent-title on|off|status
                    prefix subagent titles with the real model and thinking depth ("Terra·high · …") via a Claude Code hook

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
    case "start": {
      const r = startAgent();
      console.log(r === "already-running" ? "already running" : r === "started" ? "started" : "start failed (is it installed?)");
      break;
    }
    case "restart":
      console.log(describeRestart(restartAgent({ onProgress: (m) => console.log(`  ${m}`) })));
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
    case "picker": {
      const sub = args[1];
      if (sub === "on") await pickerOn();
      else if (sub === "off") pickerOff();
      else console.log("usage: clauderipple picker on|off");
      break;
    }
    case "codex": {
      const sub = args[1];
      if (sub !== "on" && sub !== "off") {
        console.log("usage: clauderipple codex on|off");
        break;
      }
      const cfg = new ConfigStore(configPath()).get();
      const result = sub === "on" ? codexOn(cfg.listen.openaiPort ?? cfg.listen.port + 2, undefined, ingressModels(cfg)) : codexOff();
      console.log(result.changed ? `✓ Codex ${sub}: ${result.config}${sub === "on" ? `\n✓ profile: ${result.profile}` : ""}` : `✓ Codex already ${sub}`);
      if (result.backup) console.log(`  backup: ${result.backup}`);
      if (result.profileBackup) console.log(`  profile backup: ${result.profileBackup}`);
      if (sub === "on") {
        console.log("Run: codex --profile clauderipple -m <mapped-model> \"say ok\"");
      }
      break;
    }
    case "agent-title": {
      const sub = args[1];
      const { setAgentTitleHook, agentTitleHookEnabled } = await import("./settings.ts");
      if (sub === "on" || sub === "off") {
        const r = setAgentTitleHook(sub === "on", { node: installedRuntime.node, env: installedRuntime.env, script: installedRuntime.hookScript });
        for (const n of r.notes) console.log(`✓ ${n}`);
        if (!r.changed) console.log(`✓ already ${sub}`);
        if (r.backup) console.log(`  backup: ${r.backup}`);
        console.log("Applies to new subagents from the next message on; no restart needed.");
      } else console.log(agentTitleHookEnabled() ? "on" : "off");
      break;
    }
    case "login": {
      const { login } = await import("../../router/src/providers/chatgpt/auth.ts");
      const { saveChatGptAccount, readChatGptAccounts, chatgptAccountsPath } = await import("../../router/src/providers/chatgpt/accounts.ts");
      const before = readChatGptAccounts(homeDir()).length;
      console.log(before > 0
        ? `Opening your browser to add a ChatGPT account (${before} signed in already). Sign in with the account to add; this window waits up to 5 minutes.`
        : "Opening your browser to sign in to ChatGPT. Sign in there; this window waits up to 5 minutes.");
      const grant = await login((url) => {
        if (!openBrowser(url)) console.log(`Open this URL manually:\n${url}`);
      });
      const saved = saveChatGptAccount(homeDir(), grant);
      const total = readChatGptAccounts(homeDir()).length;
      console.log(`${saved.added ? "✓ added" : "✓ signed in again as"} ${saved.email ?? saved.label} (token valid until ${new Date(grant.expiresAt).toLocaleString()}). ${total} ChatGPT account${total === 1 ? "" : "s"} in ${chatgptAccountsPath(homeDir())}`);
      break;
    }
    case "logout": {
      const { removeAllChatGptAccounts } = await import("../../router/src/providers/chatgpt/accounts.ts");
      const removed = removeAllChatGptAccounts(homeDir());
      console.log(removed > 0 ? `✓ removed ${removed} ChatGPT account${removed === 1 ? "" : "s"}` : "no ChatGPT account stored");
      break;
    }
    case "claude-login": {
      if (flag("setup-token")) {
        console.log("Opening your browser through Claude Code to connect your Claude subscription. This terminal waits for approval.");
        // CLAUDERIPPLE_ASSUME_TTY: the test drives this command through a pipe with a fake `claude`.
        claudeLogin(homeDir(), { interactive: process.stdin.isTTY || process.env.CLAUDERIPPLE_ASSUME_TTY === "1" });
        console.log("✓ Claude subscription connected for native Anthropic ingress");
        break;
      }
      // Our own browser sign-in (PKCE). No terminal interaction unless the loopback port is taken,
      // in which case the code from Anthropic's page is pasted here.
      const session = new ClaudeOAuthSession({ home: homeDir(), manual: flag("manual") });
      const { url, manual } = await session.start();
      console.log(manual ? "Opening your browser to sign in to Claude. Paste the code it shows below." : "Opening your browser to sign in to Claude. This window waits up to 5 minutes.");
      if (!openBrowser(url)) console.log(`Open this URL manually:\n${url}`);
      if (manual) {
        if (!process.stdin.isTTY) throw new Error(`the sign-in callback port ${54545} is in use and there is no terminal to paste the code into; free the port or run this in a terminal`);
        const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout });
        const code = await new Promise<string>((resolve) => rl.question("Code: ", resolve));
        rl.close();
        await session.submitCode(code);
      }
      await session.result;
      console.log(`✓ Claude subscription added. Stored privately in ${homeDir()}/claude-accounts.json; refreshed automatically.`);
      break;
    }
    case "claude-logout":
      console.log(claudeLogout(homeDir()) ? "✓ ClaudeRipple Claude accounts removed" : "no ClaudeRipple Claude accounts stored");
      break;
    case "ui":
      ui();
      break;
    case "tray": {
      const result = args.includes("--install") ? installTrayRuntime() : startTray();
      console.log(result.message);
      if (!result.ok) process.exit(1);
      break;
    }
    default:
      help();
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
