#!/usr/bin/env node
// ripple-host: runs Claude Code sessions on this machine for the phone.
//   ripple-host [--bind 127.0.0.1|tailscale|lan|0.0.0.0|<ip>] [--port 8797] [--relay <https url>|off] [--new-token]
//   ripple-host install [same options] [--print]   launchd agent com.clauderipple.host (--print: only show the plist)
//   ripple-host uninstall                           stop and remove the agent
//   ripple-host status                              agent state and health (prints no secret)
//   ripple-host pair                                print the pairing QR and link (they carry the pairing key)
// Options are remembered in host.json. The host never stops on its own; day to day it runs as the
// launchd agent (KeepAlive), which restarts it after a crash; on start it recovers persisted
// sessions and permission requests (Sessions.recover). With a relay it also keeps one outbound
// socket to it, so the phone reaches the Mac from anywhere over an https origin (relay.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { sdkQuery as query } from "./sdk-launcher.ts";
import qrcode from "qrcode-generator";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import { loadConfig, newToken, normalizeRelay, pairingUrl, relayPairingUrl, remoteHome, resolveBind, saveConfig } from "./config.ts";
import type { HostConfig } from "./config.ts";
import { MacAway } from "./away.ts";
import { toB64u } from "./e2ee.ts";
import { PermissionQueue } from "./permissions.ts";
import { PowerHold } from "./power.ts";
import { Notifier, loadVapid, webPushSender } from "./push.ts";
import { ExpoNotifier, expoSender } from "./expo-push.ts";
import { RelayHost, loadHostKey } from "./relay.ts";
import type { WsLike } from "./relay.ts";
import { RouterClient } from "./router.ts";
import { HostServer } from "./server.ts";
import { LocalControl } from "./local-control.ts";
import { findClaude, specFor, cliLoginWarning } from "./service.ts";
import { installService, uninstallService, serviceStatus, servicePaths, renderService, supervisorName, controlShutdown, refreshPlan, hostStatus, refreshRunningHost } from "./host-service.ts";
import { Sessions } from "./sessions.ts";
import { REMOTE_USAGE } from "./usage.ts";
import { desktopHandoff } from "./handoff.ts";
import { windowsSidebarRoot } from "./sidebar.ts";
import type { QueryFn } from "./sessions.ts";
import { claudeBinary, claudeCodeLogin } from "../../cli/src/claude-auth.ts";
import { ConfigStore, configPath as routerConfigPath, homeDir } from "../../router/src/config.ts";
import { VERSION } from "../../router/src/version.ts";
import { requestHostUpdate, refreshHostUpdate } from "./host-update.ts";
import { applyProcessPriority } from "../../router/src/process-priority.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (s: string): void => { process.stdout.write(s); };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function qr(text: string): string {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const dark = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const lines: string[] = [];
  // Two rows per character with half blocks and a quiet zone of 2. Black on an explicit white
  // background, so it scans the same on a light or a dark terminal.
  for (let r = -2; r < n + 2; r += 2) {
    let line = "\x1b[30;47m";
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c), bottom = dark(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n");
}

/** --bind / --port / --relay / --new-token given on the command line are remembered. */
function configFromArgs(dir: string): HostConfig {
  const cfg = loadConfig(dir);
  const bind = arg("bind");
  const port = arg("port");
  const relay = arg("relay");
  if (bind) cfg.bind = bind;
  if (port) cfg.port = Number(port);
  if (relay === "off") delete cfg.relay;
  else if (relay) cfg.relay = normalizeRelay(relay);
  if (process.argv.includes("--new-token")) cfg.token = newToken();
  if (bind || port || relay || process.argv.includes("--new-token")) saveConfig(cfg, dir);
  return cfg;
}

function printPairing(cfg: HostConfig, dir: string): void {
  const where = resolveBind(cfg.bind);
  let url: string;
  if (cfg.relay) {
    // The fragment (token, server id, host key) never leaves the phone; the relay only sees the page request.
    url = relayPairingUrl(cfg.relay, cfg.serverId, toB64u(loadHostKey(dir, nacl).publicKey), cfg.token);
    out(`\nThrough the relay ${cfg.relay} (works from anywhere; notifications need this https address).\n`);
  } else {
    url = pairingUrl(where.advertise, cfg.port, cfg.token);
    out(where.reachableFromPhone
      ? "\nDirect http: works on this network only, and without notifications (they need https: use --relay).\n"
      : "\nOnly this computer can reach it. For the phone, use --relay <url> (anywhere) or --bind lan / tailscale (same network).\n");
  }
  out(`\nScan with the phone's camera (the link carries the pairing key — do not share it):\n\n${qr(url)}\n\n${url}\n\n`);
}

/**
 * Under launchd both streams are the log file: start every line with an ISO time, so a run of
 * reconnects or errors can be placed next to sleep, network and relay events afterwards. Wraps the
 * stream itself, so lines written by libraries and child processes' relayed output get one too.
 */
function stampLines(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  let lineStart = true;
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (!text) return write(chunk, ...rest);
    let stamped = "";
    for (const piece of text.split(/(?<=\n)/)) {
      stamped += (lineStart && piece !== "\n" ? `${new Date().toISOString()} ` : "") + piece;
      lineStart = piece.endsWith("\n");
    }
    return write(stamped, ...rest);
  }) as typeof stream.write;
}

async function runHost(): Promise<void> {
  if (!process.stdout.isTTY) stampLines(process.stdout);
  if (!process.stderr.isTTY) stampLines(process.stderr);
  const log = (line: string): void => { process.stderr.write(`${line}\n`); };
  applyProcessPriority(new ConfigStore(routerConfigPath()).get().processPriority, { log });
  const dir = remoteHome();
  const cfg = configFromArgs(dir);
  const where = resolveBind(cfg.bind);
  const router = new RouterClient(cfg.adminUrl);
  const permissions = PermissionQueue.deferred(path.join(dir, "permissions.json"));
  let server: HostServer | null = null;
  const claudePath = findClaude(cfg.claudePath);
  const power = new PowerHold();
  // A VAPID subject must be an https: or mailto: URL; the relay is this host's one real https origin.
  const vapid = loadVapid(dir, cfg.relay?.startsWith("https:") ? cfg.relay : "mailto:ripple-host@clauderipple.invalid");
  let sessions: Sessions | null = null;
  const notifier = new Notifier({
    dir, send: webPushSender(vapid), log,
    seenRecently: (id) => server?.sessionSeenRecently(id) ?? false,
    summary: (id) => sessions?.summaryOf(id),
    context: (id, event) => sessions?.pushContext(id, event) ?? {},
  });
  const expoNotifier = new ExpoNotifier({ dir, send: expoSender(), log,
    seenRecently: (id) => server?.sessionSeenRecently(id) ?? false,
    context: (id, event) => sessions?.pushContext(id, event) ?? {},
    // The identity the phone paired with: a tap from a previous computer must not open a session
    // id on this one.
    host: toB64u(loadHostKey(dir, nacl).publicKey),
  });
  // Mac sessions the host is not tailing push only while the Mac is away (screen locked or idle).
  const away = new MacAway({ log });
  const handoff = claudePath ? desktopHandoff(claudePath) : undefined;
  let sidebarRoot: string | undefined;
  if (process.platform === "win32") {
    try { sidebarRoot = windowsSidebarRoot(); }
    catch (error) { log(`[desktop sidebar] discovery failed; disabled: ${error instanceof Error ? error.message : String(error)}`); }
  }
  sessions = new Sessions({
    dir, router, permissions,
    desktopProjects: path.join(os.homedir(), ".claude", "projects"),
    ...(process.platform === "darwin" ? { desktopSidebar: {} } : sidebarRoot ? { desktopSidebar: { root: sidebarRoot } } : {}),
    queryFn: query as unknown as QueryFn,
    ...(claudePath ? { claudePath } : {}),
    ...(handoff ? { handoff } : {}),
    log,
    // A Claude app turn that closed on a wrap_up question pushes that question, not its result.
    onEvent: (id, event) => {
      server?.onEvent(id);
      const push = sessions?.pushEvent(id, event) ?? event;
      void notifier.onEvent(id, push);
      void expoNotifier.onEvent(id, push);
    },
    away: () => away.away(),
    onAlert: (id, body) => { void notifier.onEvent(id, body); void expoNotifier.onEvent(id, body); },
    onSessions: () => { server?.onSessions(); if (sessions) power.update(sessions.busy()); },
    onDesktopProblem: (problem) => server?.setDesktopProblem(problem),
  });
  const live = sessions;
  const host: HostServer = new HostServer({
    listen: where.listen, port: cfg.port, token: cfg.token, webDir: path.resolve(here, "..", "web"), sessions: live, router,
    hostName: os.hostname().replace(/\.local$/, ""), version: VERSION,
    recentCli: async () => (await listSessions({ limit: 300, includeProgrammatic: false })).flatMap((s) => (s.cwd ? [{ path: s.cwd, lastUsed: s.lastModified }] : [])),
    log,
    push: { publicKey: vapid.publicKey, subscribe: (id, sub, lang) => notifier.subscribe(id, sub, lang), unsubscribe: (id) => notifier.unsubscribe(id) },
    expoPush: expoNotifier,
    pushDevices: () => [...new Set([...notifier.devices(), ...expoNotifier.devices()])],
    clearPush: () => {
      for (const id of notifier.devices()) notifier.unsubscribe(id);
      for (const id of expoNotifier.devices()) expoNotifier.unsubscribe(id);
    },
    local: new LocalControl({
      dir, config: cfg, version: VERSION, hostPublicKey: toB64u(loadHostKey(dir, nacl).publicKey),
      phones: () => server?.phones() ?? [],
      inbox: live.modInbox,
      settingsJobs: live.settingsJobs,
      rotate: token => { server?.rotateToken(token); },
      shutdown: () => stop(),
      busy: () => live.busy(),
      prepareRefresh: () => host.prepareRefresh(),
      refresh: () => stop(75),
    }),
  });
  server = host;
  await host.listen();
  // Recovery writes restart notices and stopped states. A competing foreground process
  // must fail to bind before it can append to the running host's session logs.
  try { permissions.open(); live.recover(); }
  catch (error) { await host.close(); throw error; }
  power.update(live.busy());
  const relay = cfg.relay
    ? new RelayHost({
      relay: cfg.relay, serverId: cfg.serverId, secret: cfg.relaySecret, hostKey: loadHostKey(dir, nacl), nacl, log,
      makeSocket: (url, headers) => new WebSocket(url, { headers, maxPayload: 2 * 1024 * 1024 }) as unknown as WsLike,
      onPeer: (peer) => host.connected(peer),
    })
    : null;
  relay?.start();

  out(`\nRipple Remote ${VERSION} — listening on ${where.listen}:${cfg.port}${cfg.relay ? `, relay ${cfg.relay}` : ""}\n`);
  if (claudePath) out(`Claude Code: ${claudePath}\n`);
  // Under launchd stdout is a log file; the pairing link carries the token and must not land there.
  if (process.stdout.isTTY) printPairing(cfg, dir);
  else out("Pairing QR: run `ripple-host pair` (npm run remote -- pair) in a terminal.\n");

  const stop = (code = 0): void => {
    power.release();
    relay?.stop();
    live.shutdown();
    void host.close().then(() => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  };
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
}

async function status(): Promise<void> {
  const cfg = loadConfig(remoteHome());
  const st = serviceStatus();
  const p = servicePaths();
  out(`${supervisorName()}: ${st.installed ? p.definition : "not installed"}${st.loaded ? `, loaded (state ${st.state ?? "?"}${st.pid ? `, pid ${st.pid}` : ""}${st.lastExit ? `, last exit ${st.lastExit}` : ""})` : ", not loaded"}\n`);
  const listen = resolveBind(cfg.bind).listen;
  const probe = listen === "0.0.0.0" || listen === "::" ? "127.0.0.1" : listen;
  let health = "no answer";
  try {
    const r = await fetch(`http://${probe.includes(":") ? `[${probe}]` : probe}:${cfg.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    health = r.ok ? "ok" : `HTTP ${r.status}`;
  } catch { /* no answer */ }
  out(`host: ${probe}:${cfg.port} — ${health} (bind ${cfg.bind})\n`);
  out(`relay: ${cfg.relay ?? "off"}\nlogs: ${p.log}\n`);
}

async function installCmd(): Promise<void> {
  const dir = remoteHome();
  // Read the running host's old port before command-line options persist a replacement.
  if (process.platform === "win32" && !process.argv.includes("--print")) await controlShutdown(dir);
  const cfg = process.argv.includes("--print") ? loadConfig(dir, false) : configFromArgs(dir);
  // The CLI the host will start; also what a person is told to run when it has no login.
  const claudePath = findClaude(cfg.claudePath);
  const spec = hostSpec(claudePath);
  if (process.argv.includes("--print")) { out(renderService(spec)); return; }
  for (const line of await installService(spec)) out(`${line}\n`);
  out(`Pair the phone: clauderipple remote pair\n`);
  // The host starts Claude Code through the Agent SDK and passes no credential of its own, so a
  // machine where the CLI was never logged in fails on every turn (issue #71). Say so now; the
  // install itself is never held up by it.
  const warning = cliLoginWarning(await claudeCodeLogin(), claudePath ?? claudeBinary() ?? null);
  if (warning) out(`⚠ ${warning}\n`);
}

function hostSpec(claudePath: string | undefined): ReturnType<typeof specFor> {
  return specFor({ script: fileURLToPath(import.meta.url), claudePath, ...(process.env.RIPPLE_REMOTE_HOME ? { remoteHome: process.env.RIPPLE_REMOTE_HOME } : {}) });
}

/** Run from the new files. A busy/unknown host stays pending for the router's independent retry. */
async function refreshCmd(): Promise<void> {
  const home = homeDir();
  if (!process.argv.includes("--pending")) requestHostUpdate(home, VERSION);
  const state = await refreshHostUpdate(home, VERSION, {
    plan: async () => {
      const p = servicePaths();
      let definition: string | null = null;
      try { definition = fs.readFileSync(p.definition, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const status = definition === null ? null : await hostStatus();
      return refreshPlan({ installed: serviceStatus().installed, definition, script: fileURLToPath(import.meta.url), busy: status?.busy });
    },
    apply: () => refreshRunningHost(VERSION),
    version: async () => (await hostStatus())?.version ?? null,
  });
  if (state?.status === "pending") out(`호스트 적용 대기: ${state.error ?? "진행 중인 작업이 끝나면 자동으로 다시 시도합니다."}\n`);
  else if (state?.status === "applied") out(`휴대폰 호스트에 ${VERSION} 버전을 적용했습니다.\n`);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) { out(REMOTE_USAGE); return; }
  const sub = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  switch (sub) {
    case null: return runHost();
    case "install": return installCmd();
    case "refresh": return refreshCmd();
    case "uninstall": for (const line of await uninstallService({ explicit: true })) out(`${line}\n`); return;
    case "status": return status();
    case "pair": { const dir = remoteHome(); printPairing(configFromArgs(dir), dir); return; }
    default: throw new Error(`unknown command "${sub}" (install, uninstall, status, pair)`);
  }
}

main().catch((e: Error) => {
  process.stderr.write(`ripple-host: ${e.message}\n`);
  process.exit(1);
});
