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
import { CLI_WINDOW_MAX } from "../../router/src/bootstrap.ts";
import { certsExist, certPaths, generateCerts } from "./certs.ts";
import { applyProxyEnv, checkProxyEnv, currentProxyEnv, removeProxyEnv, settingsPath } from "./settings.ts";
import { agentDefinitionPath, agentState, installAgent, isLinux, isSupported, isWindows, removeAgent, restartAgent, serviceOwnership, startAgent, stopAgent, supervisorName } from "./supervisor.ts";
import { removeBundle, writeBundle } from "./bundle.ts";
import { installTrayAgent, removeTrayAgent, trayLoginItemDecision, trayPlistPath } from "./launchd.ts";
import { nativeSupervisor, registration, writePaths } from "./registration.ts";
import { installLauncher, uninstallLauncher } from "./launcher.ts";
import type { RecoveryDeps } from "./doctor.ts";
import { applyAppProxy, caTrusted, CA_NAME, currentAppProxy, migrateLegacyAppProxy, nssDb, removeAppProxy, trustCa, untrustCa } from "./picker.ts";
import { removeClientIntegrations, setPickerEnabled } from "./integrations.ts";
import { withCommandHelp } from "./help-gate.ts";
import { runtime } from "./runtime.ts";
import { codexOff, codexOn, ingressPort } from "./codex.ts";
import { ingressModels } from "../../router/src/ingress/models.ts";
import { GROK_DEFAULT_URL } from "../../router/src/providers/grok/catalog.ts";
import { claudeLogin, claudeLogout, desktopClaudeCodeDirs } from "./claude-auth.ts";
import { openBrowser } from "./browser.ts";
import { electronPath, installTrayRuntime, startTray } from "./tray.ts";
import { dropPowerShellShim, installKind, isNewer, latestVersion, PACKAGE, runUpdate } from "./update.ts";
import { ClaudeOAuthSession } from "../../router/src/providers/claude-oauth.ts";
import { requestHostUpdate } from "../../remote/src/host-update.ts";
import { purgeHome } from "./purge.ts";

async function pickerOn(): Promise<void> {
  const home = homeDir();
  const cfg = new ConfigStore(configPath()).get();
  const caPem = certPaths(home).caPem;
  if (!fs.existsSync(path.join(home, "ca.key"))) throw new Error("ca.key missing; run `clauderipple install` first");
  // With picker mode on, every byte Claude Desktop sends goes through the router (ARCHITECTURE §5):
  // pointing the app at one that is not answering leaves it a blank page, so check first.
  const ready = await probe({ host: cfg.listen.host, port: cfg.listen.port, caPem, upstream: cfg.upstream });
  if (!ready.ok) throw new Error(`the router is not answering (${ready.detail}); picker mode not enabled. Start it with \`clauderipple start\` and try again.`);
  console.log("Picker mode makes Claude Desktop's own claude.ai traffic go through ClaudeRipple so the model picker can list your GPT models.");
  console.log(
    isWindows
      ? "Step 1/3: trusting the ClaudeRipple CA for your Windows user account. Windows will show a confirmation dialog with the certificate fingerprint — answer Yes. No administrator rights are needed."
      : isLinux
        ? `Step 1/3: trusting the ClaudeRipple CA in your NSS database (${nssDb()}), which Chromium and so Claude Desktop reads. Your user only; no password, no sudo.`
        : "Step 1/3: trusting the ClaudeRipple CA in your login keychain. macOS will ask for your password (ClaudeRipple never sees it).",
  );
  trustCa(caPem);
  if (!caTrusted(caPem)) throw new Error("CA is not trusted; picker mode not enabled");
  console.log(isWindows || isLinux ? "✓ CA trusted (current user only)" : "✓ CA trusted (login keychain only)");
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const r = applyAppProxy(proxyUrl);
  console.log(`✓ Claude Desktop config library entry applied (${r.id}${r.replaced ? `, previous entry ${r.replaced} remembered` : ""}): egressProxyUrl=${proxyUrl}`);
  setPickerEnabled(true);
  console.log("✓ picker.enabled = true (the router picks it up live; no restart)");
  console.log("\nStep 3/3 is yours: quit and reopen Claude Desktop. The app reads its proxy setting at start.");
  console.log("Then open the Code tab picker: entries from cli.extraModels should be there. `clauderipple status` shows the last injection.");
}

/** After a direct start: `repair` fixes the entry but leaves a router that answers alone (doctor.ts),
 * so it is the restart afterwards that puts the router back under its supervisor (checked on
 * Windows 11, 2026-10-23). */
const resupervise = (): string => `Run \`clauderipple repair\`, then \`clauderipple restart\` to put it back under the ${supervisorName()}.`;

function describeRestart(r: ReturnType<typeof restartAgent>): string {
  if (r === "drained") return "✓ router restarted (in-flight model calls were allowed to finish)";
  if (r === "kickstarted") return "✓ router restarted (hard restart: it did not exit on its own in time)";
  if (r === "direct") return `! router restarted outside the ${supervisorName()}: its start did not bring one up. ${resupervise()}`;
  if (r === "other-installation") return `! not restarted: the ${supervisorName()} belongs to another ClaudeRipple installation (this one's was never registered)`;
  if (r === "ownership-unknown") return `! not restarted: the ${supervisorName()} does not record which installation it belongs to`;
  if (r === "identity-unknown") return "! not restarted: the running instance could not be verified as this installation's";
  return "✗ router not restarted — run `clauderipple repair` (or `clauderipple install`)";
}

/** One line for a service operation that refused to touch an unverified definition or instance (B01). */
function describeOwnership(result: "other-installation" | "ownership-unknown" | "identity-unknown"): string {
  if (result === "other-installation") return `! left it alone: the ${supervisorName()} belongs to another ClaudeRipple installation`;
  if (result === "ownership-unknown") return `! left it alone: the ${supervisorName()} does not record which installation it belongs to`;
  return "! left it alone: its running instance could not be verified as this installation's (no installation id)";
}

function pickerOff(): void {
  const home = homeDir();
  // Capture legacy ownership before changing the picker or CA, just as uninstall does.
  const proxyUrl = proxyUrlFor(new ConfigStore(configPath()).get().listen.port);
  const desktop = currentAppProxy();
  if (desktop.ours && desktop.installationHome === undefined) {
    if (!migrateLegacyAppProxy(proxyUrl, home)) throw new Error("Claude Desktop 프록시의 설치 소유권을 확인하지 못해 피커 설정과 CA를 보존했습니다. 이 설치의 서비스를 복구하고 프록시 설정을 확인한 뒤 다시 시도해 주세요.");
  }
  const removed = removeAppProxy(proxyUrl, home);
  if (currentAppProxy().ours) throw new Error("Claude Desktop 프록시가 제거되었는지 확인하지 못해 피커 설정과 CA를 보존했습니다. 프록시를 설정한 설치와 포트를 확인한 뒤 해당 설치에서 다시 시도해 주세요.");
  console.log(removed ? "✓ Claude Desktop config library entry removed (previous entry restored if there was one)" : "✓ no ClaudeRipple config library entry");
  setPickerEnabled(false);
  console.log("✓ picker.enabled = false");
  if (isWindows) console.log("Removing the CA: Windows will ask you to confirm once more.");
  const store = isWindows ? "your user certificate store" : isLinux ? `your NSS database (${nssDb()})` : "the login keychain";
  const removal = untrustCa(certPaths(home).caPem, { sweep: false, missingCaTrustRemoved: flag("confirm-missing-ca-trust-removed") });
  console.log(
    removal === "missing" ? `CA 파일이 없어 인증서 등록 여부를 확인하지 못했습니다. 원래 인증서를 ${certPaths(home).caPem} 경로에 복원하거나, 인증서 저장소에서 이 설치의 CA를 확인하고 제거한 뒤 \`clauderipple picker off --confirm-missing-ca-trust-removed\`를 실행해 주세요. 같은 이름의 다른 설치 인증서는 삭제하지 않도록 주의해 주세요.`
    : removal === "removed" ? `✓ CA removed from ${store}`
    : removal === "absent" ? `✓ CA was not in ${store}`
    : `! CA removal was not confirmed; it may still be trusted. Remove the "${CA_NAME}" certificate from ${store} by hand.`,
  );
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

const IMAGE_USAGE = 'usage: clauderipple image "<prompt>" [-o FILE] [--aspect square|landscape|portrait] [--format png|jpeg|webp] [--transparent] [--ref FILE ...]';

/**
 * One image through the running router's ChatGPT subscription (`POST /api/image`), written to a
 * file whose path is printed — so a worker with nothing but Bash can make and then look at one.
 */
async function image(): Promise<void> {
  const prompt = args[1];
  if (!prompt || prompt.startsWith("-")) throw new Error(IMAGE_USAGE);
  const images = args.flatMap((a, i) => (a === "--ref" && args[i + 1] ? [args[i + 1]!] : [])).map((file) => {
    const ext = path.extname(file).slice(1).toLowerCase();
    return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${fs.readFileSync(file).toString("base64")}`;
  });
  const format = opt("format") ?? "png";
  const out = path.resolve(opt("o") ?? `image-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "jpeg" ? "jpg" : format}`);
  const body = {
    prompt,
    format,
    ...(opt("aspect") ? { aspect: opt("aspect") } : {}),
    ...(flag("transparent") ? { background: "transparent" } : {}),
    ...(images.length ? { images } : {}),
  };
  const port = adminPort(new ConfigStore(configPath()).get());
  // Claude Code exports its session to Bash commands; the router logs it with the image so the
  // request list shows which session spent the subscription.
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  const headers = { "content-type": "application/json", ...(session && /^[\w-]{1,128}$/.test(session) ? { "x-claude-code-session-id": session } : {}) };
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/image`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new Error(`the router is not answering on 127.0.0.1:${port}; start it with: clauderipple start`);
  }
  if (!res.ok) {
    const answer = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(answer.error ?? `HTTP ${res.status}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(out);
}

/** The version the router on this admin port reports, or null when it does not answer. */
async function runningVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(10_000) });
    const version = res.ok ? ((await res.json()) as { version?: unknown }).version : null;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
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
  const direct = fs.existsSync(path.join(home, "direct.json"));
  if (!direct) checkProxyEnv({ proxyUrl, force: flag("force") });

  // Persist the single execution contract so the GUI, admin API, hooks, and supervisor all use
  // this installation's runtime rather than any Node installation on the user's PATH.
  writePaths(installedRuntime, home);
  const shim = dropPowerShellShim(installKind(installedRuntime));
  if (shim) console.log(`✓ removed ${shim}: PowerShell's default policy refuses it, and clauderipple.cmd runs instead`);
  // Windows and Linux register node + the router script directly (schtasks.ts writes its own .cmd
  // launcher); a macOS source checkout gets a small .app so the agent shows a real name in Login Items.
  // registration.ts holds the mapping, so `repair` registers exactly the same thing.
  const reg = registration(installedRuntime, home, VERSION);
  if (reg.bundle) {
    const launcher = writeBundle({ home, node: reg.bundle.node, script: reg.bundle.script, version: reg.bundle.version });
    console.log(`✓ background item bundle written: ${path.dirname(path.dirname(path.dirname(launcher)))} (shows as "ClaudeRipple" in Login Items)`);
  }
  const plist = installAgent({ program: reg.program, args: reg.args, bundleId: reg.bundleId, home, env: reg.env });
  console.log(`✓ ${supervisorName()} registered: ${plist}${isLinux || reg.bundle ? "" : ' (shows as "ClaudeRipple" in Login Items)'}`);

  // launchd starts the agent the moment it is bootstrapped (RunAtLoad); a scheduled task waits for
  // its logon trigger, so the router would only appear after the next sign-in. Start it either way,
  // and believe it only once the router's process exists (supervisor.startRouter).
  // Durable before the successor router starts: its own completion does not imply host application.
  try {
    requestHostUpdate(home, VERSION);
  } catch (error) {
    // Bookkeeping for the phone host must never abort an install (issue #125: one refused rename
    // skipped the router restart, the probe and settings). The router retries it once the record
    // is older than the version it runs.
    console.log(`! could not schedule the phone host update (${error}); the router will retry it`);
  }
  const started = startAgent({ onProgress: (m) => console.log(`  ${m}`) });
  console.log(
    started === "failed" ? `✗ could not start the router (${supervisorName()})`
    : started === "started-directly" ? `! router started without the ${supervisorName()}. ${resupervise()}`
    : `✓ router ${started === "already-running" ? "already running" : "started"}`,
  );
  // Running the installer again is how an update arrives, and it replaces files, not the process:
  // a router left alone keeps serving the old code until the next login. Restart one that
  // answers with another version.
  if (started === "already-running") {
    const running = await runningVersion(adminPort(cfg));
    if (running && running !== VERSION) {
      console.log(`  the running router is ${running}; restarting it on ${VERSION}`);
      const restarted = restartAgent({ onProgress: (m) => console.log(`  ${m}`) });
      console.log(describeRestart(restarted));
      if (restarted === "failed") {
        // The old router may still be answering, so the probe below would pass and the installer
        // would report a version it never switched to — what the tray showed as "updated" while
        // the version stayed old until `repair` (#62, #80).
        process.exitCode = 1;
        console.log(`${settingsPath()} was left as it was: the router was not switched to ${VERSION}. Run \`clauderipple restart\`, then install again.`);
        return;
      }
    }
  }

  const p = await probeWithRetry({ host: cfg.listen.host, port: cfg.listen.port, caPem: caPath, upstream: cfg.upstream });
  console.log(p.ok ? `✓ end-to-end probe passed (${p.detail}, ${p.ms}ms)` : `✗ probe failed: ${p.detail}`);
  if (!p.ok) {
    process.exitCode = 1;
    console.log(`${settingsPath()} was left as it was, so Claude Code does not depend on a router that is not answering. Fix the router, then run install again.`);
    return;
  }
  // The cap sits at Claude Code's ceiling for a per-model window, so each routed model compacts at
  // its own window from the bootstrap (CLI_WINDOW_MAX); a flag still sets another.
  const edit = applyProxyEnv({ proxyUrl, caPath, force: flag("force"), maxContextTokens: maxCtx ? Number(maxCtx) : CLI_WINDOW_MAX, models: cfg.cli.models ?? {}, respectDirect: true, home });
  console.log(edit.changed ? `✓ ${settingsPath()} updated (backup: ${edit.backup ?? "none"})` : `✓ ${settingsPath()} already correct`);
  for (const n of edit.notes) console.log(`  note: ${n}`);
  // Something to double-click for the menu-bar app, which is what offers repair when the router is
  // down. Never fatal: the router and Claude's settings are already in place.
  try {
    const app = installLauncher({ rt: installedRuntime, home, version: VERSION });
    if (app.paths.length) console.log(`✓ menu-bar app launcher: ${app.paths.join(", ")}`);
    else if (!app.ok) console.log(`  menu-bar app launcher not written: ${app.detail}`);
  } catch (e) {
    console.log(`  menu-bar app launcher not written: ${(e as Error).message}`);
  }
  // The phone host has the same problem as the router above: new files, old process. The host
  // decides whether it is ours and idle (remote host-service refreshPlan). Never fatal.
  try {
    execFileSync(installedRuntime.node, [installedRuntime.cli, "remote", "refresh"], { env: { ...process.env, ...installedRuntime.env }, stdio: "inherit" });
  } catch {
    console.log("  호스트 적용 대기: 진행 중인 작업을 유지하며 자동으로 다시 시도합니다.");
  }
  console.log(direct ? "\nDone. Claude stays on its default connection (direct on); run \"clauderipple direct off\" to go through ClaudeRipple." : "\nDone. New Claude Desktop Code sessions go through ClaudeRipple. Existing sessions pick up settings.json env changes on their next request.");
}

async function uninstall(): Promise<void> {
  const home = homeDir();
  const cfg = new ConfigStore(configPath()).get();
  // Read before anything is unregistered: a Codex block from a version that recorded no home is
  // this installation's to remove only when this home's own definition was the one registered
  // when the uninstall started (B03).
  const serviceWasOurs = serviceOwnership(home).state === "ours";
  const desktop = currentAppProxy();
  // Capture ownership while the service and its verified process still exist. The durable home
  // marker remains usable by removeClientIntegrations after the service has been unregistered.
  if (desktop.ours && desktop.installationHome === undefined && desktop.egressProxyUrl === proxyUrlFor(cfg.listen.port)) {
    if (!migrateLegacyAppProxy(proxyUrlFor(cfg.listen.port), home)) throw new Error("Claude Desktop 프록시의 설치 소유권을 확인하지 못해 제거를 중단했습니다. 서비스를 복구한 뒤 다시 시도해 주세요.");
  }
  // The phone host is its own account-wide service and is not inside the router's definition: stop
  // and remove it first, so nothing keeps running against files this uninstall removes. Its own
  // definition decides ownership, so another installation's host is reported, not touched (D1).
  let hostRemoved = true;
  try {
    const { uninstallService } = await import("../../remote/src/host-service.ts");
    for (const line of await uninstallService({ installationHome: home })) console.log(`  ${line}`);
  } catch (e) {
    hostRemoved = false;
    process.exitCode = 1;
    console.log(`! the phone host service was not removed: ${(e as Error).message}`);
  }
  // Stop the router before unregistering it. On macOS unloading the agent takes the process with
  // it; on Windows removing the task leaves it running, and a running router holds router.log open,
  // so --purge then fails with EPERM and leaves the home directory behind (measured 2026-09-16 in a
  // Windows 11 arm64 VM). A definition that belongs to another installation is left untouched.
  const stop = stopAgent(home);
  console.log(
    stop === "stopped" ? "✓ router stopped"
    : stop === "not-loaded" ? "✓ no router registered (nothing to stop)"
    : stop === "failed" ? "! the running router did not accept a shutdown request; it was left running"
    : describeOwnership(stop),
  );
  // An instance that cannot be proven to be this installation's, or one that refused to drain, is
  // not stopped: its registration stays, and the rest of the uninstall waits rather than removing
  // settings under a live process.
  if (stop === "failed") {
    process.exitCode = 1;
    console.log("Uninstall is incomplete: the running router did not accept the shutdown request and was left running. Stop it, then run uninstall again.");
    return;
  }
  if (stop === "identity-unknown") {
    process.exitCode = 1;
    console.log(`Uninstall is incomplete: the ${supervisorName()} was left in place. Update this installation (\`clauderipple install\`) so its router reports an installation id, stop it, then run uninstall again.`);
    return;
  }
  // Before --purge can take the journal that says whether the router left sleep disabled.
  await releaseHeldSleep("uninstalled");
  const removed = removeAgent(home);
  console.log(
    removed === "removed" ? `✓ ${supervisorName()} removed (${agentDefinitionPath()})`
    : removed === "absent" ? `✓ no ${supervisorName()} registered`
    : describeOwnership(removed),
  );
  if (removed === "identity-unknown") {
    process.exitCode = 1;
    console.log("Uninstall is incomplete: the service registration was left in place because its running instance could not be verified as this installation's. Stop it, then run uninstall again.");
    return;
  }
  if (process.platform === "darwin") {
    const tray = removeTrayAgent(home);
    console.log(
      tray === "removed" ? `✓ tray login item removed (${trayPlistPath()})`
      : tray === "absent" ? "✓ no tray login item"
      : `${describeOwnership(tray)} (${trayPlistPath()})`,
    );
  }
  removeBundle(home);
  let launcherRemoved = false;
  try {
    const app = uninstallLauncher({ rt: installedRuntime, home, version: VERSION });
    launcherRemoved = app.ok;
    if (!app.ok) console.log(`  ${app.detail}`);
    if (app.paths.length) console.log(`✓ menu-bar app launcher removed (${app.paths.join(", ")})`);
  } catch (e) {
    console.log(`  could not remove the menu-bar app launcher: ${(e as Error).message}`);
  }
  const integrationsRemoved = removeClientIntegrations(home, undefined, {
    port: cfg.listen.port,
    missingCaTrustRemoved: flag("confirm-missing-ca-trust-removed"),
    ...(serviceWasOurs ? { legacyCodexIngressPort: ingressPort(cfg) } : {}),
  });
  if (!integrationsRemoved) process.exitCode = 1;
  const edit = removeProxyEnv({ proxyUrl: proxyUrlFor(cfg.listen.port), caPath: certPaths(home).caPem, ...(cfg.cli.models ? { models: cfg.cli.models } : {}), home });
  console.log(edit.changed ? `✓ ${settingsPath()} restored (backup: ${edit.backup ?? "none"})` : `✓ ${settingsPath()} had no ClaudeRipple keys`);
  for (const n of edit.notes) console.log(`  note: ${n}`);
  await reportLeftovers(home);
  if (flag("purge")) {
    if (!integrationsRemoved || !launcherRemoved || !hostRemoved || edit.notes.some(note => /left |could not /i.test(note)) || (removed !== "removed" && removed !== "absent")) {
      process.exitCode = 1;
      console.error("일부 등록을 제거하지 못해 설치 폴더를 보존했습니다. 오류를 해결한 뒤 다시 제거해 주세요.");
      return;
    }
    const result = await purgeHome(home);
    if (result.status === "deferred") {
      // Exit 0 would certify a deletion that cannot finish until this node.exe exits.
      process.exitCode = 2;
      console.log(`실행 중인 Node가 종료된 뒤 설치 폴더를 삭제합니다. 아직 완료되지 않았습니다. 종료 코드 2는 대기 상태이며, 최종 결과는 ${result.resultFile}에서 확인해 주세요 (exitCode 0: 완료, 1: 실패).`);
    } else console.log(`설치 폴더를 삭제했습니다. ${home}`);
  } else console.log(`  kept ${home} (config, certs, logs). Add --purge to delete it.`);
}

/**
 * What an uninstall leaves outside the installation home, said before that home (and with it the
 * record of the remote hosts) goes. None of it is removed here: the sudoers grant needs an
 * administrator's approval and the PATH line still serves the command that was just run, so each is
 * named with the command that removes it when the user no longer wants it (G-D02, G-D16).
 */
async function reportLeftovers(home: string): Promise<void> {
  const { remainingAwakeGrantHint } = await import("./awake-setup.ts");
  const hint = remainingAwakeGrantHint();
  if (hint) console.log(`  ${hint}`);
  const { configuredHosts } = await import("./remote.ts");
  const hosts = configuredHosts(configPath()).map((host) => host.host).filter(Boolean);
  if (hosts.length > 0) {
    console.log(`  원격(SSH) 호스트 ${hosts.length}대의 설정이 남아 있습니다: ${hosts.join(", ")}`);
    console.log("  더 이상 필요하지 않다면 각 호스트에서 `clauderipple remote remove <호스트>`를 실행해 주세요.");
  }
  console.log("  설치 명령이 셸 프로필에 추가한 PATH 설정 줄은 그대로 두었습니다. ClaudeRipple을 완전히 제거할 때는 해당 줄(주석 `# ClaudeRipple`)을 삭제해 주세요.");
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
  rows.push(["picker mode", cfg.picker?.enabled ? `on · CA ${caTrusted(caPath) ? "trusted" : "NOT trusted"} · app proxy ${ap.ours ? ap.egressProxyUrl : "NOT set"}` : `off${ap.ours ? " (app proxy entry still present — run `picker off`)" : ""}`]);
  const p = await probe({ host: cfg.listen.host, port: cfg.listen.port, caPem: caPath, upstream: cfg.upstream });
  rows.push(["probe", `${p.ok ? "ok" : "FAIL"}: ${p.detail} (${p.ms}ms)`]);
  for (const [name, p2] of Object.entries(cfg.providers)) {
    const providerUrl = p2.type === "chatgpt" ? (p2.url ?? "https://chatgpt.com") : p2.type === "anthropic" ? "https://api.anthropic.com" : p2.type === "google" ? (p2.url ?? "https://generativelanguage.googleapis.com") : p2.type === "grok" ? (p2.url ?? GROK_DEFAULT_URL) : p2.url;
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

/**
 * `update --check [--json]` reports; `update` installs the latest version the way this copy was
 * installed (update.ts) and fetches the tray's Electron again if the old copy had it.
 */
async function update(): Promise<void> {
  const kind = installKind(installedRuntime);
  // CLAUDERIPPLE_PACKAGE names what to install instead of the registry's latest (a tarball, say).
  const override = process.env.CLAUDERIPPLE_PACKAGE;
  const latest = override ? null : await latestVersion();
  const newer = latest ? isNewer(latest, VERSION) : true;
  if (flag("check")) {
    if (flag("json")) console.log(JSON.stringify({ current: VERSION, latest, newer, kind: kind.kind }));
    else console.log(newer ? `ClaudeRipple ${latest} is available (this is ${VERSION}). Update with: clauderipple update` : `ClaudeRipple ${VERSION} is the latest version`);
    return;
  }
  if (kind.kind !== "script" && kind.kind !== "npm") {
    process.exitCode = 1;
    console.log(
      kind.kind === "packaged" ? "This is the standalone app. Download the new version from https://github.com/PBJ-2/clauderipple/releases"
      : kind.kind === "checkout" ? "This is a source checkout. Update it with git pull."
      : `ClaudeRipple is installed at ${kind.root}, which is not a global npm install. Update it the way you installed it.`,
    );
    return;
  }
  if (!newer && !flag("force")) {
    console.log(`✓ ClaudeRipple ${VERSION} is the latest version`);
    return;
  }
  const hadTray = electronPath() !== null;
  const spec = override ?? `${PACKAGE}@${latest}`;
  console.log(`Updating ClaudeRipple ${VERSION} → ${latest ?? spec} (${kind.kind === "script" ? "install script" : "npm"}, ${kind.prefix})…`);
  const result = runUpdate(kind, installedRuntime, spec);
  if (result.ok && hadTray) {
    // The new files decide where Electron lives; ask them, not this process's copy. --refresh also
    // replaces a runtime the previous version fetched, which an install alone would keep (B15).
    execFileSync(installedRuntime.node, [installedRuntime.cli, "tray", "--install", "--refresh"], { env: { ...process.env, ...installedRuntime.env }, stdio: "inherit" });
  }
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}

// ---- Recovery: doctor, repair, direct, app ------------------------------------------------
//
// The menu-bar app calls these when the router is down and the dashboard with it. With --json each
// prints one JSON object on stdout and exits 0 whatever the diagnosis; a non-zero exit means the
// command itself could not run.

/** This machine's supervisor, registering this installation's runtime and files. */
function recoveryDeps(): RecoveryDeps {
  const home = homeDir();
  const ops = nativeSupervisor(registration(installedRuntime, home, VERSION), home);
  return {
    home,
    version: VERSION,
    supervisor: {
      inspect: () => ops.inspect(),
      // paths.json is part of what install registers: the GUI and hooks run what it names.
      register: () => {
        writePaths(installedRuntime, home);
        return ops.register();
      },
      start: () => ops.start(),
    },
  };
}

function printDoctor(d: Awaited<ReturnType<typeof import("./doctor.ts").doctor>>): void {
  const sup = d.supervisor;
  const rows: [string, string][] = [
    ["mode", d.mode === "ripple" ? "ClaudeRipple" : d.mode === "direct" ? "Claude's default connection (direct)" : "mixed"],
    ["router", d.router.responding ? `answering${d.router.version ? ` (${d.router.version}${d.router.pid ? `, pid ${d.router.pid}` : ""})` : ""} on ${d.router.url}` : `NOT answering (${d.router.adminUrl})`],
    [supervisorName(), sup.registered ? `registered · ${sup.state} · ${sup.programExists ? "program ok" : "PROGRAM MISSING"} (${sup.program ?? "-"})` : "NOT registered"],
    ["claude code", `${d.cli.proxy}${d.cli.url ? ` (${d.cli.url})` : ""}`],
    ["claude desktop", `${d.desktop.proxy}${d.desktop.url ? ` (${d.desktop.url})` : ""}`],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
  if (d.problems.length === 0) console.log("\n✓ no problems found");
  else {
    console.log("\nproblems:");
    for (const p of d.problems) console.log(`  ✗ ${p.message} [${p.code}]`);
    console.log("\nFix what can be fixed with: clauderipple repair");
  }
}

async function recovery(): Promise<void> {
  const json = flag("json");
  const out = (value: object, text: () => void): void => {
    if (json) console.log(JSON.stringify(value));
    else {
      text();
      if ("ok" in value && value.ok === false) process.exitCode = 1;
    }
  };
  if (cmd === "doctor") {
    const { doctor } = await import("./doctor.ts");
    const d = await doctor(recoveryDeps());
    out(d, () => printDoctor(d));
    return;
  }
  if (cmd === "repair") {
    const { repair } = await import("./doctor.ts");
    const r = await repair(recoveryDeps());
    out(r, () => {
      for (const s of r.steps) console.log(`${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`);
      console.log("");
      printDoctor(r.doctor);
    });
    return;
  }
  if (cmd === "direct") {
    const sub = args[1];
    if (sub !== "on" && sub !== "off") throw new Error("usage: clauderipple direct on|off [--force] [--json]");
    const { directOn, directOff } = await import("./direct.ts");
    const r = sub === "on" ? directOn(homeDir()) : await directOff(recoveryDeps(), { force: flag("force") });
    out(r, () => {
      console.log(`${r.ok ? "✓" : "✗"} ${r.detail}`);
      if (r.ok) console.log("Quit and reopen Claude Desktop, and start new Claude Code sessions: both read this at start.");
    });
    return;
  }
  if (cmd === "app") {
    const install = flag("install");
    if (install === flag("uninstall")) throw new Error("usage: clauderipple app --install|--uninstall [--json]");
    const o = { rt: installedRuntime, home: homeDir(), version: VERSION };
    const r = install ? installLauncher(o) : uninstallLauncher(o);
    out(r, () => console.log(`${r.ok ? "✓" : "✗"} ${r.detail}${r.paths.length ? `\n  ${r.paths.join("\n  ")}` : ""}`));
  }
}

/**
 * A router that exits leaves the lid-closed sleep bit as it was, for its successor to reconcile
 * (router awake.ts). When it is stopped for good there is no successor, so clear it here.
 */
async function releaseHeldSleep(reason: string): Promise<void> {
  const { releaseAwake, releaseFailedHint } = await import("./awake-setup.ts");
  const { execRunner } = await import("../../router/src/awake.ts");
  const r = await releaseAwake(execRunner(), homeDir(), reason);
  if (r === "released") console.log(process.platform === "win32" ? "✓ the lid-close action is back to yours (lid-closed awake had set it to Do nothing)" : "✓ sleep re-enabled (lid-closed awake was holding the Mac awake)");
  if (r === "failed") console.log(`✗ could not re-enable sleep: ${releaseFailedHint()}`);
}

function help(): void {
  console.log(`clauderipple <command>

  install [--port N] [--force] [--max-context-tokens N]
  uninstall [--purge]
    --confirm-missing-ca-trust-removed
                    CA 파일이 없고 인증서 저장소에서 이 설치의 CA를 직접 확인하고 제거한 경우에만 사용합니다.
  status
  doctor [--json]   what is wrong with the router, its background service and Claude's connection settings
  repair [--json]   fix what doctor finds: re-register and start the router, wait for it to answer
  direct on|off [--force] [--json]
                    on: use Claude's default connection (Claude Desktop and Claude Code skip ClaudeRipple;
                    the router stays installed); off: go through ClaudeRipple again. Restart Claude after either.
  app --install|--uninstall [--json]
                    a double-clickable launcher for the menu-bar app (~/Applications, Start Menu, app menu)
  start | stop | restart
  logs [-n N] [-f]
  remote [install|uninstall|status|pair]  run or manage the phone host (macOS, Windows, Linux systemd)
  remote add <ssh-host> [--port N] [--force]
                    route Claude Desktop sessions that run on a remote (SSH) host through ClaudeRipple:
                    sets up the host over your key-based ssh and keeps a reverse tunnel open (remote port, default 18791)
  remote remove <ssh-host>   undo "remote add" on that host and stop its tunnel
  remote hosts      list remote (SSH) hosts and their tunnels (also shown by "remote status")
  config            print the config file path
  ui                open the dashboard in your browser
  tray [--install]  start the menu-bar / tray app (--install fetches Electron, ~270MB, once)
  update [--check]  install the latest version the way this one was installed (--check only reports)
  login             add a ChatGPT account (opens your browser; run again to add another — they take turns when one runs out)
  logout            forget every ChatGPT account added with "login" (the Codex CLI's own login is left alone)
  claude-login      connect a Claude subscription in the browser (--setup-token: via \`claude setup-token\`; --manual: paste the code)
  claude-logout     remove every Claude subscription added to ClaudeRipple
  google-login      add a Google account for the Antigravity (Cloud Code Assist) backend (prints Google's terms warning first)
  google-logout     remove every Google account added to ClaudeRipple
  image "<prompt>" [-o FILE] [--aspect square|landscape|portrait] [--transparent] [--ref FILE ...]
                    generate an image with your ChatGPT subscription and print the file's path
  picker on|off     show your mapped models by name in the Claude Desktop picker (trusts the CA in your login keychain, routes the app through ClaudeRipple)
  codex on|off      add/remove ClaudeRipple's local OpenAI provider and selection profile for Codex CLI
  agent-title on|off|status
                    prefix subagent titles with the real model and thinking depth ("Terra·high · …") via a Claude Code hook
  mod on|off|status show where each request went above the Claude Code prompt, and the request log in a pane (/ripple-log), via a Claude Code mod
  awake setup [--ssid <hotspot name>] [--remove]
                    allow ClaudeRipple to keep the laptop awake with the lid closed (and join that phone hotspot).
                    macOS: asks for your password once in macOS's own dialog, and removes Insomnia if it is installed;
                    Windows: no administrator step, only checks (power plan, Wi-Fi adapter, saved hotspot profile)
  awake on|off|working [--until HH:MM]
                    working: awake while Claude works and 10 min after; on: always (until HH:MM); off: never
  tether on|off     join the phone hotspot when Wi-Fi has no internet, and go back to Wi-Fi when a known one works
  power [--json]    lid-closed awake and hotspot state

Home directory: ${homeDir()}  (override with CLAUDERIPPLE_HOME)`);
}

async function dispatchCommand(): Promise<void> {
  switch (cmd) {
    case "remote": {
      const sub = args[1];
      // Remote (SSH) hosts for Claude Desktop sessions; every other `remote` verb is the phone host's.
      if (sub === "add" || sub === "remove" || sub === "hosts") {
        const { remoteAdd, remoteRemove, remoteHosts, REMOTE_SSH_USAGE } = await import("./remote.ts");
        const host = args[2];
        if (sub === "hosts") await remoteHosts();
        else if (!host || host.startsWith("--")) throw new Error(REMOTE_SSH_USAGE);
        else if (sub === "add") {
          const port = opt("port");
          await remoteAdd(host, { ...(port !== undefined ? { port: Number(port) } : {}), force: flag("force") });
        } else await remoteRemove(host);
        break;
      }
      const script = path.resolve(here, "../../remote/src/main" + path.extname(fileURLToPath(import.meta.url)));
      const { spawn } = await import("node:child_process");
      const child = spawn(installedRuntime.node, [script, ...args.slice(1)], { stdio: "inherit", env: { ...process.env, ...installedRuntime.env } });
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
      if (sub === "status") {
        // Only when there are any, so the phone host's status reads exactly as before otherwise.
        const { configuredHosts, remoteHosts } = await import("./remote.ts");
        if (configuredHosts(configPath()).length > 0) {
          console.log("\nremote (SSH) hosts:");
          await remoteHosts();
        }
      }
      break;
    }
    case "install":
      await install();
      break;
    case "uninstall":
      await uninstall();
      break;
    case "status":
      await status();
      break;
    case "doctor":
    case "repair":
    case "direct":
    case "app":
      await recovery();
      break;
    case "start": {
      const r = startAgent({ onProgress: (m) => console.log(`  ${m}`) });
      console.log(
        r === "already-running" ? "already running"
        : r === "started" ? "started"
        : r === "started-directly" ? `started without the ${supervisorName()}. ${resupervise()}`
        : r === "other-installation" || r === "ownership-unknown" ? describeOwnership(r)
        : "start failed (is it installed?)",
      );
      if (r === "failed" || r === "other-installation" || r === "ownership-unknown") process.exitCode = 1;
      break;
    }
    case "restart": {
      const r = restartAgent({ onProgress: (m) => console.log(`  ${m}`) });
      console.log(describeRestart(r));
      if (r === "failed" || r === "other-installation" || r === "ownership-unknown" || r === "identity-unknown") process.exitCode = 1;
      break;
    }
    case "stop": {
      const stopped = stopAgent();
      console.log(
        stopped === "stopped" ? "stopped (run `clauderipple start` or `install` to bring it back)"
        : stopped === "not-loaded" ? "stop failed (not loaded?)"
        : stopped === "failed" ? "! the router did not accept the shutdown request; it was left running"
        : describeOwnership(stopped),
      );
      if (stopped !== "stopped" && stopped !== "not-loaded") process.exitCode = 1;
      await releaseHeldSleep("router stopped");
      break;
    }
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
      const result = sub === "on" ? codexOn(ingressPort(cfg), undefined, ingressModels(cfg), homeDir()) : codexOff(undefined, homeDir(), { legacyIngressPort: ingressPort(cfg) });
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
    case "mod": {
      const sub = args[1];
      const { setStatusMod, statusModEnabled } = await import("./settings.ts");
      if (sub === "on" || sub === "off") {
        const r = setStatusMod(sub === "on", installedRuntime.modDir);
        for (const n of r.notes) console.log(`✓ ${n}`);
        if (!r.changed) console.log(`✓ already ${sub}`);
        if (r.backup) console.log(`  backup: ${r.backup}`);
        console.log("Applies to Claude Code sessions started from now on.");
      } else console.log(statusModEnabled() ? "on" : "off");
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
    case "google-login": {
      const { GoogleOAuthSession } = await import("../../router/src/providers/google/login.ts");
      const { ANTIGRAVITY_WARNING } = await import("../../router/src/providers/google/antigravity.ts");
      const { readGoogleAccounts, googleAccountsPath } = await import("../../router/src/providers/google/accounts.ts");
      // The terms warning is printed once, before anything else, so a sign-in is never accidental.
      console.log(`⚠ ${ANTIGRAVITY_WARNING}\n`);
      const before = readGoogleAccounts(homeDir()).length;
      const session = new GoogleOAuthSession({ home: homeDir() }, ANTIGRAVITY_WARNING);
      const { url } = await session.start();
      console.log(before > 0
        ? `Opening your browser to add a Google account (${before} signed in already). Sign in with the account to add; this window waits up to 5 minutes.`
        : "Opening your browser to sign in with Google. Sign in there; this window waits up to 5 minutes.");
      if (!openBrowser(url)) console.log(`Open this URL manually:\n${url}`);
      await session.result;
      const total = readGoogleAccounts(homeDir()).length;
      console.log(`✓ Google account added. ${total} account${total === 1 ? "" : "s"} in ${googleAccountsPath(homeDir())}; refreshed automatically.`);
      break;
    }
    case "google-logout": {
      const { removeAllGoogleAccounts } = await import("../../router/src/providers/google/accounts.ts");
      const removed = removeAllGoogleAccounts(homeDir());
      console.log(removed > 0 ? `✓ removed ${removed} Google account${removed === 1 ? "" : "s"}` : "no Google account stored");
      break;
    }
    case "image":
      await image();
      break;
    case "power":
    case "awake":
    case "tether": {
      const { powerCli, adminPowerCall } = await import("./power.ts");
      const { defaultSetupDeps } = await import("./awake-setup.ts");
      const { execRunner } = await import("../../router/src/awake.ts");
      const run = execRunner();
      process.exitCode = await powerCli(args, {
        call: adminPowerCall(adminPort(new ConfigStore(configPath()).get())),
        configFile: configPath(),
        rippleHome: homeDir(),
        run,
        setupDeps: () => defaultSetupDeps(run, homeDir()),
        print: (line) => console.log(line),
        now: () => new Date(),
      });
      break;
    }
    case "ui":
      ui();
      break;
    case "update":
      await update();
      break;
    case "tray": {
      // Internal app bridge: only plist I/O, never launchctl or Electron runtime installation.
      const login = opt("login");
      if (login !== undefined) {
        const decision = trayLoginItemDecision({ platform: process.platform, packaged: installedRuntime.packaged, initialized: flag("initialized"), electronOpenAtLogin: flag("electron-login") });
        if (!decision || !["on", "off", "init"].includes(login)) throw new Error("tray --login requires on|off|init on an unpackaged macOS installation");
        if (login === "on" || (login === "init" && decision.enableAgent)) installTrayAgent(homeDir());
        else if (login === "off") removeTrayAgent();
        console.log(JSON.stringify({ on: fs.existsSync(trayPlistPath()), removeElectronItem: login === "init" && decision.removeElectronItem }));
        break;
      }
      // --ensure is what the app launcher runs: fetch Electron once if it is missing, then start.
      // --refresh (after an update) also replaces a runtime an older version fetched.
      const ensured = args.includes("--ensure") && !installedRuntime.packaged ? installTrayRuntime() : null;
      const result = args.includes("--install") ? installTrayRuntime({ refresh: flag("refresh") }) : ensured && !ensured.ok ? ensured : await startTray({ atLogin: flag("at-login") });
      console.log(result.message);
      if (!result.ok) process.exit(1);
      break;
    }
    default:
      help();
  }
}

try {
  await withCommandHelp(args, dispatchCommand, help);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
