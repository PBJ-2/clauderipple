#!/usr/bin/env node
// ClaudeRipple router entry point.
//   CLAUDERIPPLE_HOME   config + certs + logs directory (default ~/.clauderipple)
//   CLAUDERIPPLE_ECHO=1 also print log lines to stdout
//
// Exit codes: 0 clean, 2 bad config/certs, 75 upstream unreachable (supervisor should restart).

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { ConfigStore, configPath, homeDir } from "./config.ts";
import { Logger } from "./log.ts";
import { UpstreamHealth, EXIT_UPSTREAM_UNREACHABLE } from "./health.ts";
import { Proxy } from "./proxy.ts";
import { startAdmin } from "./admin.ts";

const home = homeDir();
const logFile = process.env.CLAUDERIPPLE_NO_LOGFILE ? null : path.join(home, "logs", "router.log");

let log: Logger | null = null;
const store = new ConfigStore(undefined, (c, errors) => {
  for (const e of errors) (log ?? console).warn(`config: ${e}`);
  log?.info(`config loaded: ${Object.keys(c.routes).length} routes, ${Object.keys(c.providers).length} providers, direct=${c.direct.map((d) => d.prefix).join(",") || "-"}`);
});
const cfg0 = store.get();
log = new Logger(logFile, cfg0.log.maxBytes, cfg0.log.keep, !!process.env.CLAUDERIPPLE_ECHO || !logFile);

let secureContext: tls.SecureContext;
try {
  secureContext = tls.createSecureContext({
    cert: fs.readFileSync(path.join(home, "leaf.pem")),
    key: fs.readFileSync(path.join(home, "leaf.key")),
  });
} catch (e) {
  log.error(`cannot load leaf.pem/leaf.key from ${home}: ${(e as Error).message}. Run the installer first.`);
  process.exit(2);
}

const health = new UpstreamHealth(
  () => store.get().health.maxConsecutiveUpstreamFailures,
  (n) => {
    log!.error(`${n} consecutive upstream connect failures; exiting ${EXIT_UPSTREAM_UNREACHABLE} for the supervisor to restart`);
    setTimeout(() => process.exit(EXIT_UPSTREAM_UNREACHABLE), 100);
  },
);

const proxy = new Proxy({ config: () => store.get(), log, secureContext, health, home });

process.on("uncaughtException", (e) => log!.error(`uncaught ${(e as Error).stack ?? e}`));
process.on("unhandledRejection", (e) => log!.error(`unhandled ${(e as Error)?.stack ?? e}`));
const DRAIN_MS = 45_000; // launchd ExitTimeOut is 60s; leave headroom
let draining = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (draining) return;
    draining = true;
    log!.info(`${sig}: draining, in-flight=${proxy.stats.inFlight} model calls=${proxy.stats.messagesInFlight}`);
    let lastReported = -1;
    void proxy
      .drain(DRAIN_MS, (n) => {
        if (n !== lastReported) {
          lastReported = n;
          log!.info(`drain: waiting for ${n} model call(s)`);
        }
      })
      .then(() => {
        log!.info(`drain complete, exiting (model calls still open: ${proxy.stats.messagesInFlight})`);
        setTimeout(() => process.exit(0), 200).unref();
      });
  });
}

const statsEvery = 5 * 60 * 1000;
setInterval(() => {
  const s = proxy.stats;
  log!.info(`stats started=${s.started} completed=${s.completed} failed=${s.failed} inFlight=${s.inFlight} consecutiveUpstreamFailures=${health.consecutiveFailures}`);
}, statsEvery).unref();

proxy
  .listen()
  .then(async () => {
    const c = store.get();
    log!.info(`clauderipple router listening on ${c.listen.host}:${c.listen.port} upstream=${c.upstream} home=${home}`);
    const admin = await startAdmin({
      config: () => store.get(),
      configFile: configPath(),
      log: log!,
      stats: () => proxy.stats,
      health: () => health.consecutiveFailures,
      version: "0.1.0",
      chatgpt: () => ({ quota: proxy.chatgptRateLimits, auth: proxy.chatgptAuthStatus() }),
    });
    log!.info(`clauderipple admin GUI on http://127.0.0.1:${admin.port}/`);
  })
  .catch((e) => {
    log!.error(`listen failed: ${(e as Error).message}`);
    process.exit(2);
  });
