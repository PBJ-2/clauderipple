#!/usr/bin/env node
// ClaudeRipple router entry point.
//   CLAUDERIPPLE_HOME   config + certs + logs directory (default ~/.clauderipple)
//   CLAUDERIPPLE_ECHO=1 also print log lines to stdout
//
// Exit codes: 0 clean, 2 bad config/certs, 75 upstream unreachable (supervisor should restart).

import fs from "node:fs";
import path from "node:path";
import { codexEnabled, followCodexCache, writeCodexCatalog } from "../../cli/src/codex.ts";
import { ingressModels } from "./ingress/models.ts";
import { ConfigStore, awakeSettings, configPath, homeDir, terminateHosts, tetherSettings } from "./config.ts";
import { AwakeController, execRunner, type Activity } from "./awake.ts";
import { TetherController } from "./tether.ts";
import { AutoUpdater } from "./autoupdate.ts";
import { runCli, startCliDetached } from "./cli-control.ts";
import { powerPlatform } from "./power.ts";
import { defaultAgentDir, syncAgentFiles } from "./agents.ts";
import { CertStore } from "./certs.ts";
import { Logger } from "./log.ts";
import { UpstreamHealth, EXIT_UPSTREAM_UNREACHABLE, checkConnectivity } from "./health.ts";
import { HoldGate } from "./hold.ts";
import { Proxy } from "./proxy.ts";
import { adoptNewClaudeModels, backfillContextWindows, measureUnsettledModels, startAdmin, type AdminDeps } from "./admin.ts";
import { loadModelCatalog } from "./catalog.ts";
import { RequestLog } from "./requestlog.ts";
import { OpenAiIngress } from "./ingress/server.ts";
import { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";
import { VERSION } from "./version.ts";
import { allowLongSilences } from "./providers/retry.ts";
import { assetsFingerprint, readLocalAssets, spawnSsh, syncRemoteAssets } from "./remote-host.ts";
import { RemoteTunnels, proxyConnectHost } from "./remote-tunnel.ts";

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
// Created after listen(); the config callback below runs before that and finds it null.
let tunnels: RemoteTunnels | null = null;
const store = new ConfigStore(undefined, (c, errors) => {
  for (const e of errors) (log ?? console).warn(`config: ${e}`);
  log?.info(`config loaded: ${Object.keys(c.routes).length} routes, ${Object.keys(c.providers).length} providers, direct=${c.direct.map((d) => d.prefix).join(",") || "-"}`);
  // Keep the Codex app's model list in step with the models we serve (only while `codex on` is in effect).
  try {
    if (codexEnabled()) writeCodexCatalog(ingressModels(c));
  } catch (e) {
    log?.warn(`codex catalog: ${(e as Error).message}`);
  }
  // One place for the truth: the agent files a worker's model comes from are derived from this
  // config, so a model ticked here cannot disagree with the alias a marker resolves to.
  try {
    syncAgentFiles(c, defaultAgentDir(), log ?? console);
  } catch (e) {
    (log ?? console).warn(`agent files: ${(e as Error).message}`);
  }
  // Remote hosts get the regenerated agent files too, and a hand edit of `remote.hosts` takes effect.
  tunnels?.reconcile(c.remote?.hosts ?? []);
  tunnels?.assetsChanged();
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

// One gate for the proxy and the ingress: the tether controller holds new model calls at it while
// it switches the network back to Wi-Fi (hold.ts). Closed when the router drains or exits.
const hold = new HoldGate();
const powerRunner = execRunner();
const health = new UpstreamHealth(
  () => store.get().health.maxConsecutiveUpstreamFailures,
  (n, c) => {
    const why = !c ? "" : c.result === "online" ? ` while this machine is online (${c.detail}): this process is stuck` : ` and the connectivity check could not tell (${c.detail})`;
    log!.error(`${n} consecutive upstream connect failures${why}; exiting ${EXIT_UPSTREAM_UNREACHABLE} for the supervisor to restart`);
    hold.close();
    setTimeout(() => process.exit(EXIT_UPSTREAM_UNREACHABLE), 100);
  },
  {
    // A fresh process (curl) asks first; a machine that is offline is not helped by a restart.
    connectivity: () => checkConnectivity(powerRunner, process.platform),
    onOffline: (n, c) => log!.warn(`${n} consecutive upstream connect failures, but this machine is offline too (${c.detail}); not restarting`),
  },
);

const observedClaudeCodeAuth = new ObservedClaudeCodeAuth(path.join(home, "claude-auth-observed.json"));
// Before any provider fetches: a reasoning model may stay silent past fetch's 300s default.
allowLongSilences();
const proxy = new Proxy({ config: () => store.get(), log, certs, health, home, requests, observedClaudeCodeAuth, hold });
const ingress = new OpenAiIngress({ config: () => store.get(), log, requests, home, observedClaudeCodeAuth, chatgpt: (name) => proxy.chatgptForCodex(name), hold, credentials: () => proxy.credentialHealth() });

// Lid-closed awake and hotspot failover (macOS and Windows; no-ops elsewhere, off until configured).
// They read Claude's activity from the two servers' counters. Started after listen(), below.
const activity = (): Activity => {
  const p = proxy.stats;
  const i = ingress.stats;
  const latest = (a?: number, b?: number): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
  const lastStartedAt = latest(p.lastMessageStartedAt, i.lastMessageStartedAt);
  const lastEndedAt = latest(p.lastMessageEndedAt, i.lastMessageEndedAt);
  return {
    inFlight: p.messagesInFlight + i.messagesInFlight,
    ...(lastStartedAt !== undefined ? { lastStartedAt } : {}),
    ...(lastEndedAt !== undefined ? { lastEndedAt } : {}),
  };
};
const autoUpdater = new AutoUpdater({
  home, version: VERSION, enabled: () => store.get().autoUpdate !== false,
  activity, log, runCli, startCliDetached,
});
const awake = new AwakeController({
  platform: process.platform,
  run: powerRunner,
  settings: () => awakeSettings(store.get()),
  activity,
  journalFile: path.join(home, "awake.json"),
  log: { info: (m) => log!.info(m), warn: (m) => log!.warn(m) },
});
const tether = new TetherController({
  platform: process.platform,
  run: powerRunner,
  settings: () => tetherSettings(store.get()),
  activity,
  log: { info: (m) => log!.info(m), warn: (m) => log!.warn(m) },
  hold,
  stateFile: path.join(home, "tether.json"),
});

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
  autoUpdater.stop();
  log!.info(`${reason}: draining, proxy=${proxy.stats.messagesInFlight} ingress=${ingress.stats.messagesInFlight} model calls`);
  let lastReported = -1;
  // Each drain() closes the shared hold gate first (hold.ts): a call held for a network switch is
  // let go, refused with the retryable 503 like any new call, and waited for.
  void Promise.all([
    proxy.drain(DRAIN_MS, () => {}),
    ingress.drain(DRAIN_MS, () => {}),
  ])
    .then(() => {
      const left = proxy.stats.messagesInFlight + ingress.stats.messagesInFlight;
      if (left !== lastReported) log!.info(`drain complete, exiting (model calls still open: ${left})`);
      // The sleep bit is left as it is (awake.ts header): the successor reconciles it within one
      // tick, and the journal carries the working window across the restart.
      tether.stop();
      awake.stop();
      awake.beforeExit();
      setTimeout(() => process.exit(0), 200).unref();
    });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => beginDrain(sig));
// Tunnels go with the process, not with the start of a drain: a remote session's in-flight model
// call travels through one, and the drain exists to let it finish. Every exit path ends here
// (drain, the health self-exit, a fatal startup error); a SIGKILL is covered by the pid record.
process.on("exit", () => tunnels?.stopAll());

const statsEvery = 5 * 60 * 1000;
setInterval(() => {
  const s = proxy.stats;
  const oi = ingress.stats;
  log!.info(`stats proxy=${s.started}/${s.completed}/${s.failed} inFlight=${s.inFlight} ingress=${oi.started}/${oi.completed}/${oi.failed} inFlight=${oi.inFlight} consecutiveUpstreamFailures=${health.consecutiveFailures}`);
}, statsEvery).unref();

// A key parked on an empty prepaid balance is released only by a later balance read, and the only
// reads used to be `/api/limits` and the dashboard. Left to those, a topped-up key stayed out of
// rotation for as long as nobody opened the GUI. This asks again every five minutes, and the method
// itself does nothing when no key is parked; a turn never waits on it.
setInterval(() => {
  void proxy.refreshParkedBalances().catch((e: Error) => log!.warn(`credit balance refresh: ${e.message}`));
}, 5 * 60_000).unref();

// The config callback above rewrites the Codex catalog when *our* models change; this covers
// Codex's side (a new OpenAI model arriving in its cache).
followCodexCache(() => ingressModels(store.get()), undefined, undefined, (e) => log!.warn(`codex catalog: ${e.message}`));

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
    // Reverse tunnels to remote (SSH) hosts, after listen() so their far end has something to reach.
    const assets = () => readLocalAssets({ home, agentDir: defaultAgentDir() });
    tunnels = new RemoteTunnels({
      log: log!,
      proxyTarget: () => ({ host: proxyConnectHost(store.get().listen.host), port: store.get().listen.port }),
      pidFile: path.join(home, "remote-tunnels.json"),
      sync: (host) => syncRemoteAssets(spawnSsh, host, assets()),
      fingerprint: () => {
        try {
          return assetsFingerprint(assets());
        } catch {
          return "";
        }
      },
    });
    tunnels.cleanupStale();
    tunnels.reconcile(c.remote?.hosts ?? []);
    // Quota only arrives on GPT response headers, so a quiet day left the status 11 hours stale
    // (2026-09-20). Ask once now, after listen(), and never wait for the answer.
    proxy.chatgptRefreshAll();
    const adminDeps: AdminDeps = {
      autoUpdater,
      config: () => store.get(),
      configFile: configPath(),
      log: log!,
      stats: () => proxy.stats,
      health: () => health.consecutiveFailures,
      providerHealth: () => proxy.providerHealth.snapshot(),
      version: VERSION,
      requests,
      chatgpt: () => ({
        quota: proxy.chatgptRateLimits,
        auth: proxy.chatgptAuthStatus(),
        refresh: (name) => proxy.chatgptFetchRateLimits(name),
        models: (name) => proxy.chatgptFetchModels(name),
        accounts: () => proxy.chatgptAccounts(),
        clearCooldown: (id) => proxy.chatgptClearCooldown(id),
      }),
      google: () => ({
        accounts: () => proxy.googleAccounts(),
        models: (name: string) => proxy.googleFetchModels(name),
        usage: (name: string) => proxy.googleUsage(name),
        clearCooldown: (id: string) => proxy.googleClearCooldown(id),
        recheckVerification: (id: string) => proxy.googleRecheckVerification(id),
      }),
      credentials: () => proxy.credentialHealth(),
      picker: () => ({ enabled: !!store.get().picker?.enabled, hosts: terminateHosts(store.get()).slice(1), last: proxy.lastPickerInjection }),
      observedClaudeCodeAuth,
      claudeUsage: () => proxy.claudeUsage.snapshot(),
      claudeModels: () => proxy.claudeModels.list(),
      creditBalance: (name: string) => proxy.creditLimits(name),
      opencodeUsage: (name: string) => proxy.opencodeLimits(name),
      providerKeys: (name: string) => proxy.providerKeys(name),
      credentialClear: (provider: string, id: string) => proxy.credentialClear(provider, id),
      providerRemoved: (provider: string) => proxy.providerRemoved(provider),
      grokUsage: (name: string) => proxy.grokLimits(name),
      image: (req, signal, meta) => proxy.generateImage(req, signal, meta),
      modelCatalog: () => loadModelCatalog(),
      shutdown: () => beginDrain("shutdown requested"),
      remote: {
        status: () => tunnels!.status(),
        reload: () => {
          tunnels!.reconcile(store.get().remote?.hosts ?? []);
          return tunnels!.status();
        },
      },
      power: {
        status: () => ({ platform: powerPlatform(process.platform), awake: awake.status(), tether: tether.status() }),
        pin: (on) => tether.setPin(on),
        poke: async () => {
          tether.kick();
          await awake.refresh();
        },
      },
    };
    const admin = await startAdmin(adminDeps);
    log!.info(`clauderipple admin GUI on http://127.0.0.1:${admin.port}/`);
    // The first awake tick is the reconcile: a bit a previous process set is kept or cleared now.
    void awake.start().catch((e: Error) => log!.warn(`awake: ${e.message}`));
    tether.start();
    if (!draining) autoUpdater.start();
    setImmediate(premintLeaves);
    // A minute in, once start-up traffic has settled: first the catalogue's context windows are
    // written into models already saved without one (a one-shot pass), then a few one-token requests
    // per model whose effort nobody has measured yet, so effort works without the owner re-saving the
    // provider. The backfill runs first so its write lands before the measured jobs re-read the config.
    setTimeout(() => {
      void backfillContextWindows(adminDeps)
        .catch((e: Error) => log!.warn(`context windows: ${e.message}`))
        .finally(() => measureUnsettledModels(adminDeps));
    }, 60_000).unref();
    // Claude releases reach the declared models without a ClaudeRipple release: checked a minute in,
    // then every six hours (the catalogue itself is cached for an hour).
    const adopt = () => void adoptNewClaudeModels(adminDeps).catch((e: Error) => log!.warn(`claude models: ${e.message}`));
    setTimeout(adopt, 60_000).unref();
    setInterval(adopt, 6 * 60 * 60_000).unref();
  })
  .catch((e) => {
    log!.error(`listen failed: ${(e as Error).message}`);
    process.exit(2);
  });
