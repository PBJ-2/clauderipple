#!/usr/bin/env node
// ClaudeRipple router entry point.
//   CLAUDERIPPLE_HOME   config + certs + logs directory (default ~/.clauderipple)
//   CLAUDERIPPLE_ECHO=1 also print log lines to stdout
//
// Exit codes: 0 clean, 2 bad config/certs, 75 upstream unreachable (supervisor should restart).

import fs from "node:fs";
import path from "node:path";
import { codexEnabled, writeCodexCatalog } from "../../cli/src/codex.ts";
import { ingressModels } from "./ingress/models.ts";
import { ConfigStore, configPath, homeDir, terminateHosts } from "./config.ts";
import { CertStore } from "./certs.ts";
import { Logger } from "./log.ts";
import { UpstreamHealth, EXIT_UPSTREAM_UNREACHABLE } from "./health.ts";
import { Proxy } from "./proxy.ts";
import { startAdmin } from "./admin.ts";
import { RequestLog } from "./requestlog.ts";
import { OpenAiIngress } from "./ingress/server.ts";
import { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";

// Startup timing. Claude Desktop routes *all* its traffic through us in picker mode, so every
// second before the socket is open is a second the app cannot reach anything (ERR_PROXY_-
// CONNECTION_FAILED, observed 2026-09-14 after a reboot: 26s between exec and listening).
// `timeOrigin` is process start, so `node` covers interpreter boot + module loading.
const T_MODULE = Date.now();
const T_EXEC = Math.round(performance.timeOrigin);
const since = (t: number): number => Date.now() - t;

const home = homeDir();
const logFile = process.env.CLAUDERIPPLE_NO_LOGFILE ? null : path.join(home, "logs", "router.log");

let log: Logger | null = null;
const store = new ConfigStore(undefined, (c, errors) => {
  for (const e of errors) (log ?? console).warn(`config: ${e}`);
  log?.info(`config loaded: ${Object.keys(c.routes).length} routes, ${Object.keys(c.providers).length} providers, direct=${c.direct.map((d) => d.prefix).join(",") || "-"}`);
  // Keep the Codex app's model list in step with the models we serve (only while `codex on` is in effect).
  try {
    if (codexEnabled()) writeCodexCatalog(ingressModels(c));
  } catch (e) {
    log?.warn(`codex catalog: ${(e as Error).message}`);
  }
});
const cfg0 = store.get();
log = new Logger(logFile, cfg0.log.maxBytes, cfg0.log.keep, !!process.env.CLAUDERIPPLE_ECHO || !logFile);
const T_CONFIG = Date.now();

const certs = new CertStore(home);
const requests = new RequestLog(path.join(home, "logs", "requests.jsonl"));
try {
  certs.register(cfg0.upstream, fs.readFileSync(path.join(home, "leaf.pem")), fs.readFileSync(path.join(home, "leaf.key")));
} catch (e) {
  log.error(`cannot load leaf.pem/leaf.key from ${home}: ${(e as Error).message}. Run the installer first.`);
  process.exit(2);
}
// Picker mode: mint leaves for the app's own hosts so the first CONNECT is not slowed down.
// Runs *after* listen(): minting generates an RSA key pair, and a client that has to wait a moment
// for its first CONNECT is far better off than one whose connection is refused outright. Lazy
// minting in the CONNECT path (proxy.ts) covers anything that arrives before this finishes.
function premintLeaves(): void {
  for (const h of terminateHosts(store.get())) {
    if (certs.has(h)) continue;
    try {
      certs.contextFor(h);
      log!.info(`picker: certificate ready for ${h}`);
    } catch (e) {
      log!.error(`picker: cannot mint certificate for ${h}: ${(e as Error).message}`);
    }
  }
}

const health = new UpstreamHealth(
  () => store.get().health.maxConsecutiveUpstreamFailures,
  (n) => {
    log!.error(`${n} consecutive upstream connect failures; exiting ${EXIT_UPSTREAM_UNREACHABLE} for the supervisor to restart`);
    setTimeout(() => process.exit(EXIT_UPSTREAM_UNREACHABLE), 100);
  },
);

const observedClaudeCodeAuth = new ObservedClaudeCodeAuth(path.join(home, "claude-auth-observed.json"));
const proxy = new Proxy({ config: () => store.get(), log, certs, health, home, requests, observedClaudeCodeAuth });
const ingress = new OpenAiIngress({ config: () => store.get(), log, requests, home, observedClaudeCodeAuth });

process.on("uncaughtException", (e) => log!.error(`uncaught ${(e as Error).stack ?? e}`));
process.on("unhandledRejection", (e) => log!.error(`unhandled ${(e as Error)?.stack ?? e}`));
const DRAIN_MS = 90_000; // new model calls are refused during drain, so this is the longest single call we wait for; `clauderipple restart` waits 120s
let draining = false;

/**
 * Stop accepting, let in-flight model calls finish, exit. Idempotent.
 *
 * Reachable two ways: a POSIX signal, and `POST /api/shutdown`. The second exists because Windows
 * has no SIGTERM — `process.kill(pid, "SIGTERM")` terminates the target outright there, which
 * would cut the drain — so a supervisor asks over the admin API instead and waits for the process
 * to go. The same path serves both platforms rather than only being exercised on one.
 */
function beginDrain(reason: string): void {
  if (draining) return;
  draining = true;
  log!.info(`${reason}: draining, proxy=${proxy.stats.messagesInFlight} ingress=${ingress.stats.messagesInFlight} model calls`);
  let lastReported = -1;
  void Promise.all([
    proxy.drain(DRAIN_MS, () => {}),
    ingress.drain(DRAIN_MS, () => {}),
  ])
    .then(() => {
      const left = proxy.stats.messagesInFlight + ingress.stats.messagesInFlight;
      if (left !== lastReported) log!.info(`drain complete, exiting (model calls still open: ${left})`);
      setTimeout(() => process.exit(0), 200).unref();
    });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => beginDrain(sig));

const statsEvery = 5 * 60 * 1000;
setInterval(() => {
  const s = proxy.stats;
  const oi = ingress.stats;
  log!.info(`stats proxy=${s.started}/${s.completed}/${s.failed} inFlight=${s.inFlight} ingress=${oi.started}/${oi.completed}/${oi.failed} inFlight=${oi.inFlight} consecutiveUpstreamFailures=${health.consecutiveFailures}`);
}, statsEvery).unref();

proxy
  .listen()
  .then(async () => {
    const c = store.get();
    log!.info(
      `clauderipple router listening on ${c.listen.host}:${c.listen.port} upstream=${c.upstream} home=${home}` +
        ` (startup ${since(T_EXEC)}ms: node ${T_MODULE - T_EXEC}, config ${T_CONFIG - T_MODULE}, listen ${since(T_CONFIG)})`,
    );
    const ingressPort = await ingress.listen();
    log!.info(`clauderipple OpenAI ingress listening on 127.0.0.1:${ingressPort}`);
    const admin = await startAdmin({
      config: () => store.get(),
      configFile: configPath(),
      log: log!,
      stats: () => proxy.stats,
      health: () => health.consecutiveFailures,
      version: "0.1.0",
      requests,
      chatgpt: () => ({ quota: proxy.chatgptRateLimits, auth: proxy.chatgptAuthStatus() }),
      picker: () => ({ enabled: !!store.get().picker?.enabled, hosts: terminateHosts(store.get()).slice(1), last: proxy.lastPickerInjection }),
      observedClaudeCodeAuth,
      shutdown: () => beginDrain("shutdown requested"),
    });
    log!.info(`clauderipple admin GUI on http://127.0.0.1:${admin.port}/`);
    setImmediate(premintLeaves);
  })
  .catch((e) => {
    log!.error(`listen failed: ${(e as Error).message}`);
    process.exit(2);
  });
