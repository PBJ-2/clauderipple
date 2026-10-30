// Which installation is answering on an admin port, and which process it is.
//
// A port and a version string are not identity: two installations on one account can be configured
// for the same admin port, and any HTTP server answering `/api/status` with a version would look
// like "our router". The router reports the installation id and pid it captured when it started;
// a response counts as this installation's only when that id matches the id in our home *and* the
// pid is the very process the supervisor would act on. A direct router of the same home holding
// the port therefore does not authorize touching the supervised job (B01/D6, 2026-10-25).
//
// A router from before the id existed (0.12.14 and earlier) reports neither. It is accepted as
// this installation's only with the two pieces of evidence it can give: `home` is this home, and
// the process listening on this home's admin port is exactly the pid the supervisor would act on.
// Without both, the answer stays "other", so the upgrade path cannot be used to touch a stranger.
// Nothing here signals a process.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { ConfigStore, homeDir } from "../../router/src/config.ts";
import { adminPort } from "../../router/src/admin.ts";
import { ensureInstallationId, readInstallationId } from "../../router/src/installation-id.ts";
import { sameHome } from "./ownership.ts";
import { runtime } from "./runtime.ts";

/** "absent": nothing answers; "other": something answers but is not provably this instance. */
export type RouterIdentity = "ours" | "other" | "absent";

/** One status read. Injected in tests so no server or child process is needed. */
export type StatusProbe = (url: string, timeoutMs: number) => Record<string, unknown> | null;

/** The pids listening on a local TCP port; null when that cannot be determined, [] when none do. */
export type ListenPids = (port: number) => number[] | null;

/** The identity of whatever answered, plus the pid it claimed. */
export type RouterProbe = { state: RouterIdentity; pid: number | null };

/** How long "absent" is waited out. Injected in tests so no test sleeps through a budget. */
export type IdentityWait = { budgetMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => void };

/** This installation's admin API, from its own config. */
export function adminUrl(home: string = homeDir()): string {
  const cfg = new ConfigStore(path.join(home, "config.json")).get();
  return `http://127.0.0.1:${adminPort(cfg)}`;
}

function quiet(command: string, args: string[]): string | null {
  try {
    // On 2026-10-29, PowerShell took over 5 s to start at full CPU, and null made restart reject its own router.
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, windowsHide: true });
  } catch {
    return null;
  }
}

/**
 * The processes listening on `port`, with the tool each platform has. Only a read: no signal, no
 * connection. An unreadable answer is null, never "nothing listens" — the two differ for ownership.
 */
export const listenPids: ListenPids = (port) => {
  const found = new Set<number>();
  const collect = (text: string | null, pattern: RegExp): boolean => {
    if (text === null) return false;
    for (const match of text.matchAll(pattern)) {
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 0) found.add(pid);
    }
    return true;
  };
  if (process.platform === "win32") {
    const out = quiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) -join "\`n"`]);
    return collect(out, /(\d+)/g) ? [...found] : null;
  }
  if (process.platform === "linux") {
    // `ss` is iproute2; a container without it falls back to lsof, and without either the answer
    // is unknown rather than "nothing listens".
    if (collect(quiet("ss", ["-ltnp", `sport = :${port}`]), /pid=(\d+)/g)) return [...found];
    return collect(quiet("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]), /^(\d+)$/gm) ? [...found] : null;
  }
  return collect(quiet("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]), /^(\d+)$/gm) ? [...found] : null;
};

/**
 * The real probe runs in a child process, so a hung admin API cannot hold the CLI: it prints the
 * parsed status and exits, and anything else (refusal, timeout, non-JSON) reads as no answer.
 */
export function probeStatus(url: string, timeoutMs: number): Record<string, unknown> | null {
  try {
    const rt = runtime();
    const script = `fetch(${JSON.stringify(url)}, {signal: AbortSignal.timeout(${timeoutMs})}).then(async r => { if (!r.ok) process.exit(1); const s = await r.json(); process.stdout.write(JSON.stringify(s)); }).catch(() => process.exit(1));`;
    const out = execFileSync(rt.node, ["-e", script], { env: { ...process.env, ...rt.env }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: timeoutMs + 1_000 }).toString();
    const parsed = JSON.parse(out) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * This installation's id if it has one, creating it on first use: an upgrade that did not re-run
 * `install` still gets an id, and a router of the new version reports it on the next request.
 */
function ownInstallationId(home: string): string | null {
  const existing = readInstallationId(home);
  if (existing) return existing;
  try {
    return ensureInstallationId(home);
  } catch {
    return null;
  }
}

/**
 * Identifies the responder. `expectedPid` is the process the caller would act on (the supervisor's
 * job/unit pid, or the router under the registered task); when given, a responder with any other
 * pid is `"other"`, even if its installation id matches. Pass `null` when the caller has no such
 * process: a responder then cannot authorize anything.
 *
 * A status from before the id existed is `"ours"` only when it reports this home and the listener
 * on this home's admin port is exactly `expectedPid`. Otherwise `"other"`.
 */
export function probeRouter(home: string = homeDir(), opts: { probe?: StatusProbe; timeoutMs?: number; expectedPid?: number | null; listenPids?: ListenPids } = {}): RouterProbe {
  const status = (opts.probe ?? probeStatus)(`${adminUrl(home)}/api/status`, opts.timeoutMs ?? 3_000);
  if (status === null) return { state: "absent", pid: null };
  const pid = Number(status.pid);
  const answeredPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  // An upgrade that has not re-run `install` still gets an id here, so a router of the new
  // version can report it on its next request.
  const expected = ownInstallationId(home);
  // The key absent, not null: a router that reports null is the current version and has no identity.
  if (!("installId" in status)) {
    if (typeof status.home !== "string" || !sameHome(status.home, home)) return { state: "other", pid: answeredPid };
    if (opts.expectedPid === undefined || opts.expectedPid === null) return { state: "other", pid: answeredPid };
    const port = Number(new URL(adminUrl(home)).port);
    const listeners = (opts.listenPids ?? listenPids)(port);
    if (listeners === null || !listeners.includes(opts.expectedPid)) return { state: "other", pid: answeredPid };
    return { state: "ours", pid: opts.expectedPid };
  }
  // No id of our own, no instance pid, or another id: nothing can be proven, so never "ours".
  if (!expected) return { state: "other", pid: answeredPid };
  if (typeof status.installId !== "string" || status.installId !== expected) return { state: "other", pid: answeredPid };
  if (answeredPid === null) return { state: "other", pid: null };
  if (opts.expectedPid !== undefined && opts.expectedPid !== answeredPid) return { state: "other", pid: answeredPid };
  return { state: "ours", pid: answeredPid };
}

/** Convenience for callers that only need the state. */
export function routerIdentity(home: string = homeDir(), opts: { probe?: StatusProbe; timeoutMs?: number; expectedPid?: number | null; listenPids?: ListenPids } = {}): RouterIdentity {
  return probeRouter(home, opts).state;
}

/** How long a just-started process is given to answer before its "absent" stands. */
const IDENTITY_BUDGET_MS = 15_000;

/**
 * The identity of a process the supervisor has just (re)started, waited for.
 *
 * A relaunched router needs a moment before it opens its admin port, and a probe in that gap sees
 * "absent". One probe there made `clauderipple restart` report a healthy restart as "! not
 * restarted: the running instance could not be verified as this installation's" (2026-10-26 10:29:
 * pid 31308 drained, launchd started 37683, which later answered with this installation's id). So
 * "absent" is retried until the budget ends, while "ours" and "other" answer at once. `reread` is
 * asked between rounds because a supervisor can start the process again: the pid running then is
 * the pid judged, and it is the one returned. Waiting never turns an answer into "ours" — when
 * nothing answers within the budget the "absent" stands and the caller still refuses.
 */
export function awaitIdentity(
  identity: (expectedPid: number | null) => RouterIdentity,
  pid: number | null,
  reread: () => number | null = () => pid,
  wait: IdentityWait = {},
): RouterProbe {
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const deadline = now() + (wait.budgetMs ?? IDENTITY_BUDGET_MS);
  let current = pid;
  let state = identity(current);
  while (state === "absent" && now() < deadline) {
    sleep(wait.pollMs ?? 250);
    const next = reread();
    if (next !== null) current = next;
    state = identity(current);
  }
  return { state, pid: current };
}
