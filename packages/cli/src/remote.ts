// clauderipple remote add|remove|hosts — Claude Desktop sessions on a remote (SSH) host (issue #67).
//
// `add` prepares the remote over the user's own key-based ssh (CA certificate, settings.json env,
// agent files; remote-host.ts), records the host in config.json, and asks the running router to
// open the reverse tunnel (remote-tunnel.ts). `remove` undoes exactly that. The phone host keeps
// `remote install|uninstall|status|pair` and the bare `remote`; these verbs are new beside them.

import fs from "node:fs";
import { defaultAgentDir } from "../../router/src/agents.ts";
import { ConfigStore, adminPort, configPath, homeDir } from "../../router/src/config.ts";
import { writeJsonAtomic } from "../../router/src/locked-file.ts";
import {
  DEFAULT_REMOTE_PORT, REMOTE_DIR, SETTINGS_BACKUP_SUFFIX, SshConnectError, assetLines, hostProblem, inspectRemote, planAgents, portProblem,
  readLocalAssets, remoteCaPath, remoteProxyUrl, runRemoteScript, script, settingsGuardLine, settingsWriteLines, spawnSsh,
  type RemoteRecord, type RemoteState, type SshRunner,
} from "../../router/src/remote-host.ts";
import type { TunnelStatus } from "../../router/src/remote-tunnel.ts";
import { refuseForeignProxy } from "./settings.ts";

export type RemoteOptions = {
  /** Runs ssh; injected in tests. */
  run?: SshRunner;
  /** ClaudeRipple home: ca.pem and generated-agents.json. */
  home?: string;
  /** Where the generated agent files are (~/.claude/agents). */
  agentDir?: string;
  configFile?: string;
  /** The router's admin API; null skips it (the tunnel then starts with the router). */
  adminUrl?: string | null;
  print?: (line: string) => void;
  /** How long `add` waits to see the tunnel up. */
  waitMs?: number;
};

type Settings = Record<string, unknown>;

function parseSettings(text: string | null, host: string): Settings {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${host}:~/.claude/settings.json is not valid JSON (${(e as Error).message}); fix it first — nothing was changed`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${host}:~/.claude/settings.json is not a JSON object; nothing was changed`);
  return parsed as Settings;
}

function envOf(s: Settings): Record<string, string> {
  return { ...((s.env as Record<string, string> | undefined) ?? {}) };
}

/**
 * The remote settings.json with our two env keys set, or null when it already has them. Same rule
 * as the local install (settings.ts): every other key is kept, and a different HTTPS_PROXY is
 * refused unless forced.
 */
export function mergeRemoteSettings(text: string | null, host: string, want: { proxyUrl: string; caPath: string }, force: boolean): { content: string | null; notes: string[] } {
  const s = parseSettings(text, host);
  const env = envOf(s);
  try {
    refuseForeignProxy(env.HTTPS_PROXY, want.proxyUrl, force);
  } catch (e) {
    throw new Error(`${host}: ${(e as Error).message}`);
  }
  const notes: string[] = [];
  if (env.HTTPS_PROXY && env.HTTPS_PROXY !== want.proxyUrl) notes.push(`replaced HTTPS_PROXY ${env.HTTPS_PROXY}`);
  if (env.NODE_EXTRA_CA_CERTS && env.NODE_EXTRA_CA_CERTS !== want.caPath) notes.push(`replaced NODE_EXTRA_CA_CERTS ${env.NODE_EXTRA_CA_CERTS}`);
  if (env.HTTPS_PROXY === want.proxyUrl && env.NODE_EXTRA_CA_CERTS === want.caPath) return { content: null, notes };
  env.HTTPS_PROXY = want.proxyUrl;
  env.NODE_EXTRA_CA_CERTS = want.caPath;
  return { content: JSON.stringify({ ...s, env }, null, 2) + "\n", notes };
}

/** The remote settings.json without our two keys (only where they still hold our values), or null when unchanged. */
export function unmergeRemoteSettings(text: string | null, host: string, ours: { proxyUrl: string; caPath: string }): { content: string | null; notes: string[] } {
  if (text === null) return { content: null, notes: [] };
  const s = parseSettings(text, host);
  const env = envOf(s);
  const notes: string[] = [];
  let changed = false;
  for (const [key, value] of [["HTTPS_PROXY", ours.proxyUrl], ["NODE_EXTRA_CA_CERTS", ours.caPath]] as const) {
    if (env[key] === value) {
      delete env[key];
      changed = true;
    } else if (env[key]) notes.push(`left ${key}=${env[key]} (not ours)`);
  }
  if (!changed) return { content: null, notes };
  const next = { ...s };
  if (Object.keys(env).length === 0) delete next.env;
  else next.env = env;
  return { content: JSON.stringify(next, null, 2) + "\n", notes };
}

// ---- config.json ---------------------------------------------------------------------------

type HostEntry = { host: string; port: number };

export function configuredHosts(configFile: string): HostEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as { remote?: { hosts?: unknown } };
    const hosts = raw.remote?.hosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is HostEntry => !!h && typeof h.host === "string" && typeof h.port === "number") : [];
  } catch {
    return [];
  }
}

/** Rewrite `remote.hosts` in config.json, everything else as it was; atomic, as the router hot-reloads it. */
function updateHosts(configFile: string, mutate: (hosts: HostEntry[]) => HostEntry[]): void {
  if (!fs.existsSync(configFile)) throw new Error(`no config at ${configFile}; run \`clauderipple install\` first`);
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
  const remote = (raw.remote && typeof raw.remote === "object" ? raw.remote : {}) as Record<string, unknown>;
  const hosts = mutate(Array.isArray(remote.hosts) ? (remote.hosts as HostEntry[]) : []);
  if (hosts.length > 0) raw.remote = { ...remote, hosts };
  else delete raw.remote;
  writeJsonAtomic(configFile, raw);
}

// ---- the router ----------------------------------------------------------------------------

type RouterAnswer = { ok: true; hosts: TunnelStatus[] } | { ok: false; why: string };

async function routerCall(adminUrl: string | null, method: "GET" | "POST", pathname: string): Promise<RouterAnswer> {
  if (adminUrl === null) return { ok: false, why: "not asked" };
  try {
    const res = await fetch(`${adminUrl}${pathname}`, { method, signal: AbortSignal.timeout(5_000) });
    if (res.status === 404 || res.status === 501) return { ok: false, why: "the running router does not manage remote tunnels (an older version?); restart it with `clauderipple restart`" };
    if (!res.ok) return { ok: false, why: `the router answered HTTP ${res.status}` };
    return { ok: true, hosts: ((await res.json()) as { hosts?: TunnelStatus[] }).hosts ?? [] };
  } catch {
    return { ok: false, why: "the router is not answering; the tunnel starts when it does (`clauderipple start`)" };
  }
}

function defaultAdminUrl(configFile: string): string {
  return `http://127.0.0.1:${adminPort(new ConfigStore(configFile).get())}`;
}

function describe(s: TunnelStatus): string {
  return `${s.state}${s.state === "up" ? ` since ${s.since}` : ""}${s.lastError ? ` — ${s.lastError}` : ""}`;
}

function resolved(opts: RemoteOptions) {
  const configFile = opts.configFile ?? configPath();
  return {
    run: opts.run ?? spawnSsh,
    home: opts.home ?? homeDir(),
    agentDir: opts.agentDir ?? defaultAgentDir(),
    configFile,
    adminUrl: opts.adminUrl === undefined ? defaultAdminUrl(configFile) : opts.adminUrl,
    print: opts.print ?? ((line: string) => console.log(line)),
    waitMs: opts.waitMs ?? 20_000,
  };
}

function reachError(host: string, e: unknown): Error {
  if (e instanceof SshConnectError) {
    return new Error(
      `${e.message}\nClaudeRipple uses your own ssh with key-based login and never asks for a password. Set that up first ` +
        `(for example \`ssh-copy-id ${host}\`), check that \`ssh ${host} true\` runs without a prompt, then run this again.`,
    );
  }
  return e as Error;
}

// ---- commands ------------------------------------------------------------------------------

export async function remoteAdd(host: string, o: { port?: number; force?: boolean } & RemoteOptions = {}): Promise<void> {
  const problem = hostProblem(host);
  if (problem) throw new Error(problem);
  const port = o.port ?? DEFAULT_REMOTE_PORT;
  const portError = portProblem(port);
  if (portError) throw new Error(`--port: ${portError}`);
  const r = resolved(o);
  const assets = readLocalAssets({ home: r.home, agentDir: r.agentDir });
  if (!fs.existsSync(r.configFile)) throw new Error(`no config at ${r.configFile}; run \`clauderipple install\` first`);

  let state: RemoteState;
  try {
    state = await inspectRemote(r.run, host);
  } catch (e) {
    throw reachError(host, e);
  }
  r.print(`✓ ${host}: key-based ssh works (home ${state.home})`);

  const want = { proxyUrl: remoteProxyUrl(port), caPath: remoteCaPath(state.home) };
  const settings = mergeRemoteSettings(state.settings, host, want, o.force === true);
  const plan = planAgents(assets.agents.map((a) => a.name), state);
  // The CA goes before the env that names it; the guard before both, so a refusal changes nothing.
  const lines = settings.content !== null
    ? [settingsGuardLine(state), ...assetLines(assets, plan, want), ...settingsWriteLines(state, settings.content)]
    : assetLines(assets, plan, want);
  await runRemoteScript(r.run, host, script(lines));

  r.print(`✓ CA certificate copied to ${want.caPath} (the public certificate only)`);
  if (settings.content !== null) {
    r.print(`✓ ${host}:~/.claude/settings.json env: HTTPS_PROXY=${want.proxyUrl}, NODE_EXTRA_CA_CERTS=${want.caPath}`);
    if (state.settings !== null && !state.backup) r.print(`  backup: ~/.claude/settings.json${SETTINGS_BACKUP_SUFFIX}`);
  } else r.print(`✓ ${host}:~/.claude/settings.json already points at the tunnel`);
  for (const n of settings.notes) r.print(`  note: ${n}`);
  r.print(`✓ ${plan.write.length} agent file${plan.write.length === 1 ? "" : "s"} copied to ~/.claude/agents${plan.remove.length ? `, ${plan.remove.length} no longer generated removed` : ""}`);
  for (const n of plan.skipped) r.print(`  note: ~/.claude/agents/${n}.md on ${host} is not ours; left alone`);

  updateHosts(r.configFile, (hosts) => [...hosts.filter((h) => h.host !== host), { host, port }]);
  r.print(`✓ ${host} saved in ${r.configFile}`);

  const reload = await routerCall(r.adminUrl, "POST", "/api/remote/reload");
  if (!reload.ok) {
    if (r.adminUrl !== null) r.print(`  ${reload.why}`);
    return;
  }
  // The tunnel comes up asynchronously; say how it went rather than that it was asked for.
  const deadline = Date.now() + r.waitMs;
  let last = reload.hosts.find((h) => h.host === host);
  while (last?.state !== "up" && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    const now = await routerCall(r.adminUrl, "GET", "/api/remote");
    if (now.ok) last = now.hosts.find((h) => h.host === host);
  }
  if (last?.state === "up") r.print(`✓ tunnel up: 127.0.0.1:${port} on ${host} reaches ClaudeRipple. New Claude Desktop sessions on ${host} go through it.`);
  else {
    r.print(`✗ tunnel ${last ? describe(last) : "not started"}. The router keeps retrying; \`clauderipple remote hosts\` shows its state.`);
    process.exitCode = 1;
  }
}

export async function remoteRemove(host: string, o: RemoteOptions = {}): Promise<void> {
  const problem = hostProblem(host);
  if (problem) throw new Error(problem);
  const r = resolved(o);
  const entry = configuredHosts(r.configFile).find((h) => h.host === host);
  // The tunnel goes first, so nothing re-copies files while they are being removed.
  if (entry) {
    updateHosts(r.configFile, (hosts) => hosts.filter((h) => h.host !== host));
    r.print(`✓ ${host} removed from ${r.configFile}`);
    const reload = await routerCall(r.adminUrl, "POST", "/api/remote/reload");
    r.print(reload.ok ? "✓ tunnel stopped" : `  ${reload.why}`);
  } else r.print(`  ${host} was not in ${r.configFile}; cleaning up the host anyway`);

  let state: RemoteState;
  try {
    state = await inspectRemote(r.run, host);
  } catch (e) {
    const err = reachError(host, e);
    throw new Error(`${err.message}\nNothing on ${host} was changed. Run \`clauderipple remote remove ${host}\` again once it is reachable.`);
  }
  const record: RemoteRecord = state.record ?? { agents: [] };
  const ours = { proxyUrl: record.proxyUrl ?? remoteProxyUrl(entry?.port ?? DEFAULT_REMOTE_PORT), caPath: record.caPath ?? remoteCaPath(state.home) };
  const settings = unmergeRemoteSettings(state.settings, host, ours);
  const lines: string[] = [];
  if (settings.content !== null) lines.push(...settingsWriteLines(state, settings.content));
  lines.push(...planAgents([], { record, agentFiles: state.agentFiles }).remove.map((n) => `rm -f "$HOME/.claude/agents/${n}.md"`));
  lines.push(`if [ -n "$HOME" ] && [ "$HOME" != "/" ]; then rm -rf "$HOME/${REMOTE_DIR}"; fi`);
  await runRemoteScript(r.run, host, script(lines));

  r.print(settings.content !== null ? `✓ ${host}:~/.claude/settings.json: HTTPS_PROXY and NODE_EXTRA_CA_CERTS removed (everything else kept)` : `✓ ${host}:~/.claude/settings.json had no ClaudeRipple keys`);
  for (const n of settings.notes) r.print(`  note: ${n}`);
  r.print(`✓ ${record.agents.length} agent file${record.agents.length === 1 ? "" : "s"} we copied removed, and ~/${REMOTE_DIR}`);
  if (state.backup) r.print(`  the original settings.json is still in ~/.claude/settings.json${SETTINGS_BACKUP_SUFFIX}`);
}

export async function remoteHosts(o: RemoteOptions = {}): Promise<void> {
  const r = resolved(o);
  const hosts = configuredHosts(r.configFile);
  if (hosts.length === 0) {
    r.print("no remote (SSH) hosts. Add one with: clauderipple remote add <ssh-host> [--port N]");
    return;
  }
  const live = await routerCall(r.adminUrl, "GET", "/api/remote");
  const w = Math.max(...hosts.map((h) => h.host.length));
  for (const h of hosts) {
    const s = live.ok ? live.hosts.find((x) => x.host === h.host) : undefined;
    r.print(`${h.host.padEnd(w)}  127.0.0.1:${h.port}  ${s ? describe(s) : live.ok ? "not started" : live.why}`);
  }
}

export const REMOTE_SSH_USAGE = "usage: clauderipple remote add <ssh-host> [--port N] [--force] | remote remove <ssh-host> | remote hosts";
