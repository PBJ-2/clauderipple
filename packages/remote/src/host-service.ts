// Host supervision, independent of the router's task/unit and process lifetime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as launchd from "./service.ts";
import * as windows from "../../cli/src/schtasks.ts";
import { renderUnit } from "../../cli/src/systemd.ts";
import { recordedLaunchHome } from "../../cli/src/launcher.ts";
import { type AgentStop, type Ownership, ownerOf, plistEnvironment, unitEnvironment } from "../../cli/src/ownership.ts";
import { loadConfig, remoteHome } from "./config.ts";
import { assertGeneration, definitionGeneration, withServiceLockAsync, writeServiceFile } from "../../cli/src/service-definition.ts";

export const TASK = "ClaudeRippleHost";
export const UNIT = "clauderipple-host.service";
type Spec = launchd.PlistSpec;
export const supervisorName = (platform = process.platform): string => platform === "darwin" ? "launchd agent" : platform === "win32" ? "scheduled task" : "systemd user service";
export function servicePaths(platform = process.platform, home = os.homedir()): { definition: string; log: string; runtime: string } {
  const runtime = path.join(home, ".clauderipple", "host-service");
  if (platform === "darwin") { const p = launchd.paths(home); return { definition: p.plist, log: p.log, runtime }; }
  if (platform === "win32") return { definition: path.join(runtime, `${TASK}.ps1`), log: path.join(runtime, "logs", "launcher.log"), runtime };
  return { definition: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", UNIT), log: `journalctl --user -u ${UNIT}`, runtime };
}

/** The home an install without CLAUDERIPPLE_HOME uses. */
function defaultInstallationHome(): string {
  return process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple");
}

/**
 * Who the registered host service belongs to (D1, 2026-10-25). The definition is account-wide
 * (one label, one task, one unit) and records the installation home it was written for — the same
 * evidence a router service definition carries. Pure: parses text and compares homes.
 */
export function hostServiceOwnership(definitionText: string | null, platform: NodeJS.Platform, installationHome: string): Ownership {
  if (definitionText === null) return { state: "absent", home: null };
  const recorded = platform === "darwin" ? plistEnvironment(definitionText).CLAUDERIPPLE_HOME ?? null
    : platform === "linux" ? unitEnvironment(definitionText).CLAUDERIPPLE_HOME ?? null
    : recordedLaunchHome(definitionText, "win32");
  return ownerOf(recorded, installationHome);
}

function readDefinition(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function systemctl(args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 150_000, stdio: ["ignore", "pipe", "pipe"] });
}
export function unit(spec: Spec): string {
  return renderUnit({ program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: spec.workingDir, env: spec.env })
    .replace("Description=ClaudeRipple local model router", "Description=Ripple Remote host");
}
export function renderService(spec: Spec, platform = process.platform): string {
  if (platform === "darwin") return launchd.plist(spec);
  if (platform === "linux") return unit(spec);
  if (platform === "win32") return windows.renderLauncher({ program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: servicePaths(platform).runtime, env: spec.env, watchdog: false });
  throw new Error(`host service is unsupported on ${platform}`);
}

/** An authenticated local request, never a pairing credential or a public shutdown endpoint. */
export async function controlShutdown(dir = remoteHome()): Promise<void> {
  const cfg = loadConfig(dir, false);
  let secret: string;
  try { secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const url = `http://127.0.0.1:${cfg.port}`;
  const headers = { "x-ripple-local": secret };
  // Check first: a refused secret or incompatible live host must not lead to a hard kill.
  let status: Response;
  try { status = await fetch(`${url}/local/status`, { headers, signal: AbortSignal.timeout(2000), redirect: "error" }); }
  catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") return;
    throw new Error("could not check the host before shutdown");
  }
  if (!status.ok) throw new Error(`host local status refused (${status.status})`);
  await status.body?.cancel();
  const response = await fetch(`${url}/local/shutdown`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`host shutdown refused (${response.status}); update the host before stopping its task`);
  await response.body?.cancel();
  for (let i = 0; i < 100; i++) {
    await delay(100);
    try {
      const probe = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
      await probe.body?.cancel();
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return;
      throw new Error("could not confirm host shutdown");
    }
  }
  throw new Error("host did not finish shutdown; its task was left alone");
}

async function waitForHost(dir = remoteHome()): Promise<void> {
  const cfg = loadConfig(dir, false);
  for (let i = 0; i < 100; i++) {
    try {
      const secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim();
      const response = await fetch(`http://127.0.0.1:${cfg.port}/local/status`, { headers: { "x-ripple-local": secret }, redirect: "error", signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status === 403) throw new Error("host local authentication refused");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
    }
    await delay(100);
  }
  throw new Error("host service was registered but did not answer its authenticated status; check its logs");
}

/**
 * What an update does to the phone host. Updating replaces the files but not the running process, so
 * without a restart the host kept the old code until the machine rebooted (2026-10-22, a Windows
 * user on 0.12.4 still got 0.12.3's "cannot send"). Only a host this installation registered is
 * restarted — one run from a source checkout is someone else's — and never one mid-turn.
 */
export type RefreshPlan = "absent" | "foreign" | "busy" | "restart";
export function refreshPlan(o: { installed: boolean; definition: string | null; script: string; busy: boolean | undefined }): RefreshPlan {
  if (!o.installed || o.definition === null) return "absent";
  const xml = o.script.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (![o.script, xml, o.script.replace(/'/g, "''")].some(form => o.definition!.includes(form))) return "foreign";
  // Missing status is not proof of idle; retain the application intent instead of stopping it.
  return o.busy === false ? "restart" : "busy";
}

/** Unknown liveness is not permission to stop a host. Callers retain a pending update. */
export async function hostStatus(dir = remoteHome()): Promise<{ busy?: boolean; version?: string } | null> {
  try {
    const cfg = loadConfig(dir, false);
    const secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim();
    const response = await fetch(`http://127.0.0.1:${cfg.port}/local/status`, { headers: { "x-ripple-local": secret }, redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json() as { busy?: unknown; version?: unknown };
    return { ...(typeof body.busy === "boolean" ? { busy: body.busy } : {}), ...(typeof body.version === "string" ? { version: body.version } : {}) };
  } catch { return null; }
}
/** The live host reserves idle and exits itself with a retryable status; never kill via a supervisor. */
export async function refreshRunningHost(version: string, dir = remoteHome()): Promise<void> {
  const cfg = loadConfig(dir, false);
  const secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${cfg.port}/local/refresh`, { method: "POST", headers: { "x-ripple-local": secret }, redirect: "error", signal: AbortSignal.timeout(2000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(response.status === 404 ? "안전한 자동 교체를 지원하지 않는 호스트입니다. 작업이 끝난 뒤 호스트를 다시 시작해 주세요." : `host refresh deferred (${response.status})`);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await delay(200);
    if ((await hostStatus(dir))?.version === version) return;
  }
  throw new Error("host did not start the target version; application remains pending");
}

export async function installService(spec: Spec, deps: HostServiceDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return installServiceLocked(spec, deps);
  return withServiceLockAsync(servicePaths(platform, deps.userHome).definition, () => installServiceLocked(spec, deps));
}

async function installServiceLocked(spec: Spec, deps: HostServiceDeps): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  const installationHome = spec.env.CLAUDERIPPLE_HOME ?? defaultInstallationHome();
  const p = servicePaths(platform, deps.userHome);
  const read = deps.readDefinition ?? (() => readDefinition(p.definition));
  let generation = definitionGeneration(read());
  const check = () => assertGeneration(read, generation);
  const owner = hostServiceOwnership(read(), platform, installationHome);
  if (owner.state === "unknown") throw new Error("휴대폰 호스트 서비스의 설치 소유권을 확인할 수 없어 기존 정의를 보존했습니다.");
  if (owner.state === "other") throw new Error(`the phone host service belongs to another ClaudeRipple installation (${owner.home}); remove it with that installation's uninstall`);
  if (platform === "darwin") return launchd.install(spec, deps.launchctl, launchd.paths(deps.userHome));
  if (platform === "win32") {
    await (deps.shutdown ?? controlShutdown)();
    check();
    const task = deps.windows ?? windows;
    const stopped = task.stopAgent(TASK, { home: p.runtime, ...(deps.taskDeps ? { deps: deps.taskDeps } : {}) });
    if (stopped !== "stopped" && stopped !== "not-loaded") throw new Error(`휴대폰 호스트의 작업을 중지하지 못했습니다. (${stopped})`);
    check();
    // The router's launcher probes the router's admin port; the host has none of that config, so it keeps the plain loop.
    task.installAgent({ name: TASK, program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: p.runtime, env: spec.env, watchdog: false }, deps.taskDeps);
    generation = definitionGeneration(windows.renderLauncher({ program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: p.runtime, env: spec.env, watchdog: false }));
    check();
    const started = task.startAgent(TASK, { home: p.runtime, ...(deps.taskDeps ? { deps: deps.taskDeps } : {}) });
    if (started !== "started" && started !== "already-running") throw new Error(`휴대폰 호스트의 작업을 시작하지 못했습니다. (${started})`);
  } else if (platform === "linux") {
    const manager = deps.systemctl ?? systemctl;
    const call = (args: string[]) => { check(); manager(args); check(); };
    call(["show-environment"]); // Fail before writing when there is no user manager.
    if (fs.existsSync(p.definition) && !fs.readFileSync(p.definition, "utf8").startsWith("[Unit]\nDescription=Ripple Remote host\n")) throw new Error("refusing to replace a foreign host unit");
    check();
    const definition = unit(spec);
    writeServiceFile(p.definition, definition);
    generation = definitionGeneration(definition);
    call(["daemon-reload"]);
    call(["enable", UNIT]);
    call(["restart", UNIT]);
  } else throw new Error(`host service is unsupported on ${platform}`);
  await (deps.waitForHost ?? waitForHost)();
  check();
  return [`installed and started ${p.definition}`, `logs: ${p.log}`];
}
/** What a caller may inject so an uninstall can be tested without launchd, systemd or PowerShell. */
export type HostServiceDeps = {
  platform?: NodeJS.Platform;
  userHome?: string;
  launchctl?: launchd.Run;
  systemctl?: (args: string[]) => string;
  installationHome?: string;
  readDefinition?: () => string | null;
  windows?: Pick<typeof windows, "stopAgent" | "startAgent" | "installAgent" | "removeAgent">;
  taskDeps?: windows.TaskDeps;
  shutdown?: () => Promise<void>;
  waitForHost?: () => Promise<void>;
  stop?: () => Promise<void | AgentStop> | void | AgentStop;
  removeDefinition?: () => void;
  /** Retained for caller compatibility; an explicit request never substitutes for ownership. */
  explicit?: boolean;
};

/**
 * Removes the phone host service, but only one this home may take. It is account-wide, so a
 * release check under its own home must not remove the real installation's host; a definition that
 * records another home or records no home is preserved, even on an explicit request. As with the
 * router, a user request is not ownership evidence (B01, D1).
 */
export async function uninstallService(deps: HostServiceDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin" && !deps.stop && !deps.removeDefinition) return uninstallServiceLocked(deps);
  return withServiceLockAsync(servicePaths(platform, deps.userHome).definition, () => uninstallServiceLocked(deps));
}

async function uninstallServiceLocked(deps: HostServiceDeps): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  const home = deps.installationHome ?? defaultInstallationHome();
  const p = servicePaths(platform, deps.userHome);
  let text: string | null;
  try {
    text = (deps.readDefinition ?? (() => readDefinition(p.definition)))();
  } catch (error) {
    throw new Error(`the phone host service definition could not be read (${(error as Error).message}); left it alone`);
  }
  let generation = definitionGeneration(text);
  const check = () => assertGeneration(deps.readDefinition ?? (() => readDefinition(p.definition)), generation);
  const owner = hostServiceOwnership(text, platform, home);
  if (owner.state === "absent") return ["no phone host service was installed"];
  if (owner.state === "other") throw new Error(`the phone host service belongs to another ClaudeRipple installation (${owner.home}); left it alone`);
  if (owner.state === "unknown") {
    throw new Error("휴대폰 호스트 서비스의 설치 소유권을 확인할 수 없어 기존 정의를 보존했습니다.");
  }
  const lines: string[] = [];
  if (!deps.stop && !deps.removeDefinition && platform === "darwin") {
    const result = launchd.uninstall(deps.launchctl, launchd.paths(deps.userHome), text);
    if ("detail" in result) throw new Error(result.detail);
    return result.lines;
  }
  if (deps.stop) {
    const stopped = await deps.stop();
    check();
    if (stopped !== undefined && stopped !== "stopped" && stopped !== "not-loaded") throw new Error(`휴대폰 호스트의 작업을 중지하지 못했습니다. (${stopped})`);
  } else if (platform === "win32") {
    await (deps.shutdown ?? controlShutdown)();
    check();
    const task = deps.windows ?? windows;
    const options = { home: p.runtime, ...(deps.taskDeps ? { deps: deps.taskDeps } : {}) };
    const stopped = task.stopAgent(TASK, options);
    if (stopped !== "stopped" && stopped !== "not-loaded") throw new Error(`휴대폰 호스트의 작업을 중지하지 못했습니다. (${stopped})`);
    check();
    const removed = task.removeAgent(TASK, options);
    if (removed !== "removed" && removed !== "absent") throw new Error(`휴대폰 호스트의 작업을 제거하지 못했습니다. (${removed})`);
  } else if (platform === "linux") {
    check();
    (deps.systemctl ?? systemctl)(["disable", "--now", UNIT]);
    check();
  } else throw new Error(`host service is unsupported on ${platform}`);
  check();
  if (deps.removeDefinition) deps.removeDefinition();
  else {
    fs.rmSync(p.definition, { force: true });
    generation = definitionGeneration(null);
    if (platform === "linux") {
      check();
      (deps.systemctl ?? systemctl)(["daemon-reload"]);
      check();
    }
  }
  lines.push(`removed ${p.definition}`);
  return lines;
}
export function serviceStatus(): ReturnType<typeof launchd.agentStatus> {
  if (process.platform === "darwin") return launchd.agentStatus();
  const p = servicePaths();
  if (process.platform === "win32") {
    const state = windows.agentState(TASK);
    return { installed: state !== "not-loaded", loaded: state !== "not-loaded", state, pid: null, lastExit: null };
  }
  let state = "not-loaded", pid: number | null = null;
  if (process.platform === "linux" && fs.existsSync(p.definition)) {
    state = systemctl(["show", UNIT, "--property=ActiveState", "--value"]).trim();
    pid = Number(systemctl(["show", UNIT, "--property=MainPID", "--value"]).trim()) || null;
  }
  return { installed: fs.existsSync(p.definition), loaded: state !== "not-loaded", state, pid, lastExit: null };
}
