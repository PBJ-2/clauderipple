#!/usr/bin/env node
// ClaudeRipple router entry point.
//   CLAUDERIPPLE_HOME   config + certs + logs directory (default ~/.clauderipple)
//   CLAUDERIPPLE_ECHO=1 also print log lines to stdout
//
// Exit codes: 0 clean, 2 bad config/certs, 75 upstream unreachable (supervisor should restart).

import fs from "node:fs";
import path from "node:path";
import { ConfigStore, configPath, homeDir, terminateHosts } from "./config.ts";
import { CertStore } from "./certs.ts";
import { Logger } from "./log.ts";
import { UpstreamHealth, EXIT_UPSTREAM_UNREACHABLE } from "./health.ts";
import { Proxy } from "./proxy.ts";
import { startAdmin } from "./admin.ts";
import { RequestLog } from "./requestlog.ts";
import { OpenAiIngress } from "./ingress/server.ts";
import { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";

const home = homeDir();
const logFile = process.env.CLAUDERIPPLE_NO_LOGFILE ? null : path.join(home, "logs", "router.log");

let log: Logger | null = null;
const store = new ConfigStore(undefined, (c, errors) => {
  for (const e of errors) (log ?? console).warn(`config: ${e}`);
  log?.info(`config loaded: ${Object.keys(c.routes).length} routes, ${Object.keys(c.providers).length} providers, direct=${c.direct.map((d) => d.prefix).join(",") || "-"}`);
});
const cfg0 = store.get();
log = new Logger(logFile, cfg0.log.maxBytes, cfg0.log.keep, !!process.env.CLAUDERIPPLE_ECHO || !logFile);

const certs = new CertStore(home);
const requests = new RequestLog(path.join(home, "logs", "requests.jsonl"));
try {
  certs.register(cfg0.upstream, fs.readFileSync(path.join(home, "leaf.pem")), fs.readFileSync(path.join(home, "leaf.key")));
} catch (e) {
  log.error(`cannot load leaf.pem/leaf.key from ${home}: ${(e as Error).message}. Run the installer first.`);
  process.exit(2);
}
// Picker mode: mint leaves for the app's own hosts up front so the first CONNECT is not slowed down.
for (const h of terminateHosts(cfg0)) {
  if (certs.has(h)) continue;
  try {
    certs.contextFor(h);
    log.info(`picker: certificate ready for ${h}`);
  } catch (e) {
    log.error(`picker: cannot mint certificate for ${h}: ${(e as Error).message}`);
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
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (draining) return;
    draining = true;
    log!.info(`${sig}: draining, proxy=${proxy.stats.messagesInFlight} ingress=${ingress.stats.messagesInFlight} model calls`);
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
  });
}

const statsEvery = 5 * 60 * 1000;
setInterval(() => {
  const s = proxy.stats;
  const oi = ingress.stats;
  log!.info(`stats proxy=${s.started}/${s.completed}/${s.failed} inFlight=${s.inFlight} ingress=${oi.started}/${oi.completed}/${oi.failed} inFlight=${oi.inFlight} consecutiveUpstreamFailures=${health.consecutiveFailures}`);
}, statsEvery).unref();

proxy
  .listen()
  .then(async () => {
    const ingressPort = await ingress.listen();
    const c = store.get();
    log!.info(`clauderipple router listening on ${c.listen.host}:${c.listen.port} upstream=${c.upstream} home=${home}`);
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
    });
    log!.info(`clauderipple admin GUI on http://127.0.0.1:${admin.port}/`);
  })
  .catch((e) => {
    log!.error(`listen failed: ${(e as Error).message}`);
    process.exit(2);
  });
