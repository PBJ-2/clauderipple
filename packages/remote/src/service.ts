// Running the host day to day: its own launchd agent (spec: `com.clauderipple.host`, KeepAlive,
// ProcessType Interactive; not inside the router, which must not restart to ship host changes).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBinary, claudeLoginHint, desktopClaudeCacheRoots, insideDesktopClaudeCache, type CacheRootOptions, type ClaudeCodeLogin } from "../../cli/src/claude-auth.ts";
import { ownerOf, plistEnvironment } from "../../cli/src/ownership.ts";
import { assertGeneration, definitionGeneration, readServiceFile, withServiceFile } from "../../cli/src/service-definition.ts";

export const LABEL = "com.clauderipple.host";

// ---- where things are --------------------------------------------------------------------------

/** The user's own CLI when there is one: it is the version the router's measurements and the ripple mod are kept current with. */
export function findClaude(configured: string | undefined, exists: (p: string) => boolean = fs.existsSync,
  opts: { platform?: NodeJS.Platform; home?: string; pathValue?: string } = {}): string | undefined {
  if (configured) return configured;
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = opts.home ?? os.homedir();
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];
  const dirs = [p.join(home, ".local", "bin"), ...(platform === "win32" ? [p.join(process.env.APPDATA ?? p.join(home, "AppData", "Roaming"), "npm")] : ["/opt/homebrew/bin", "/usr/local/bin"]),
    ...(opts.pathValue ?? process.env.PATH ?? process.env.Path ?? "").split(platform === "win32" ? ";" : ":")];
  for (const dir of dirs.filter(Boolean)) for (const name of names) {
    const candidate = p.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  // Shared discovery also covers both AppData roots and Desktop's version/hash cache layout.
  return platform === process.platform && exists === fs.existsSync ? claudeBinary() ?? undefined : undefined;
}

/**
 * The one line `remote install` prints when the Claude Code CLI has no login of its own: the host
 * starts Claude Code through the Agent SDK and passes no credential, so every phone turn would
 * fail at once with the CLI's own "Not logged in" (issue #71). Null when there is a login.
 */
export function cliLoginWarning(login: ClaudeCodeLogin, binary: string | null): string | null {
  if (login.ok) return null;
  return `Claude Code has no login on this computer, so phone sessions will fail until it has one. ${claudeLoginHint(binary)}`;
}

// ---- launchd ------------------------------------------------------------------------------------

export interface PlistSpec {
  node: string;
  script: string;
  args: string[];
  workingDir: string;
  log: string;
  env: Record<string, string>;
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function plist(spec: PlistSpec): string {
  const program = [spec.node, "--disable-warning=ExperimentalWarning", spec.script, ...spec.args];
  const env = Object.entries(spec.env).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${program.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(spec.workingDir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>${xml(spec.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

/** PATH for the agent: launchd starts it with almost nothing, and the SDK spawns `claude`, which spawns git, rg, node… */
export function agentPath(claudePath: string | undefined, nodePath: string, opts: { platform?: NodeJS.Platform; pathValue?: string; cacheRoots?: readonly string[]; rootOptions?: CacheRootOptions; log?: (line: string) => void } = {}): string {
  const platform = opts.platform ?? process.platform;
  const roots = opts.cacheRoots ?? cacheRootsOrNone(opts.log, opts.rootOptions);
  const delimiter = platform === "win32" ? ";" : ":";
  const dir = platform === "win32" ? path.win32.dirname : path.posix.dirname;
  const dirs = platform !== "darwin"
    ? [...(claudePath ? [dir(claudePath)] : []), dir(nodePath), ...((opts.pathValue ?? process.env.PATH ?? process.env.Path ?? "").split(delimiter))]
    : [...(claudePath ? [dir(claudePath)] : []), dir(nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  // Claude Desktop's CLI cache is versioned (claude-code/<version>/<hash>) and the app deletes the old
  // version after an update. A directory baked here would outlive it, and findClaude scans PATH before
  // the cache, so the host would keep looking for a launcher that is gone (#162). The host puts the
  // directory of the launcher it finds at each start on its own PATH instead (main.ts).
  return Array.from(new Set(dirs.filter(entry => !insideDesktopClaudeCache(entry, roots, platform)))).join(delimiter);
}

type PathEnv = Record<string, string | undefined>;
const pathKey = (env: PathEnv, platform: NodeJS.Platform): string =>
  platform === "win32" ? Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH" : "PATH";

/**
 * Claude Desktop's CLI cache roots, for cleaning a PATH. Never throws and never stops the caller: a
 * root that cannot be worked out (an unreadable `Claude-Data` on Windows) is logged and means
 * "nothing to strip" for that root.
 */
function cacheRootsOrNone(log?: (line: string) => void, opts: CacheRootOptions = {}): readonly string[] {
  const say = log ?? ((line: string) => console.error(line));
  try { return desktopClaudeCacheRoots({ ...opts, onError: error => say(`[host] could not list Claude Desktop's CLI cache directories (${errorText(error)}); nothing is stripped for them`) }); }
  catch (error) { say(`[host] could not list Claude Desktop's CLI cache directories (${errorText(error)}); nothing is stripped`); return []; }
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * At the start of the host, before it looks for `claude`: drop the PATH entries that point into
 * Claude Desktop's versioned CLI cache. A host service installed before agentPath learned to leave
 * them out still carries one (ClaudeRippleHost.ps1 held `...\claude-code\2.1.304\<hash>` after the
 * app moved on, #162), and findClaude scans PATH before that cache, so the stale directory would win
 * at every start. The cache itself is still searched, newest version first.
 *
 * Never throws. Returns the PATH as it was and the entries taken out, so the caller can put it back.
 */
export function dropStaleClaudePath(env: PathEnv = process.env, opts: { platform?: NodeJS.Platform; cacheRoots?: readonly string[]; rootOptions?: CacheRootOptions; log?: (line: string) => void } = {}): { key: string; original: string | undefined; removed: string[] } {
  const platform = opts.platform ?? process.platform;
  const key = pathKey(env, platform);
  const original = env[key];
  const none = { key, original, removed: [] as string[] };
  if (original === undefined) return none;
  try {
    const roots = opts.cacheRoots ?? cacheRootsOrNone(opts.log, opts.rootOptions);
    const delimiter = platform === "win32" ? ";" : ":";
    const entries = original.split(delimiter);
    const removed = entries.filter(entry => insideDesktopClaudeCache(entry, roots, platform));
    if (removed.length) env[key] = entries.filter(entry => !insideDesktopClaudeCache(entry, roots, platform)).join(delimiter);
    return { key, original, removed };
  } catch (error) {
    (opts.log ?? ((line: string) => console.error(line)))(`[host] could not clean Claude Desktop's stale CLI directories off PATH (${errorText(error)}); PATH is left as it was`);
    env[key] = original;
    return none;
  }
}

/**
 * The CLI the host will run, found at the start of `runHost`. An explicitly configured one (host.json
 * `claudePath`) always wins. Otherwise stale entries in Claude Desktop's versioned cache are taken off
 * PATH and discovery runs; if it then finds nothing, the original PATH is restored and discovery runs
 * again, so a host that found a launcher before this cleanup still finds it (ambiguous Windows
 * profiles list no cache directory to search, and the PATH entry may be the only launcher there is).
 * Which of these happened is logged. The launcher's directory then leads PATH.
 */
export function resolveHostClaude(configured: string | undefined, env: PathEnv = process.env, opts: { platform?: NodeJS.Platform; cacheRoots?: readonly string[]; rootOptions?: CacheRootOptions; find?: (pathValue: string) => string | undefined; log?: (line: string) => void } = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const log = opts.log ?? ((line: string) => console.error(line));
  const find = opts.find ?? ((pathValue: string) => findClaude(undefined, undefined, { pathValue }));
  const { key, original, removed } = dropStaleClaudePath(env, { platform, ...(opts.cacheRoots ? { cacheRoots: opts.cacheRoots } : {}), ...(opts.rootOptions ? { rootOptions: opts.rootOptions } : {}), log });
  const listed = removed.join(platform === "win32" ? "; " : ", ");
  let claudePath: string | undefined;
  if (configured) {
    claudePath = configured;
    if (removed.length) log(`[host] dropped ${removed.length} stale Claude Desktop CLI directories from PATH (${listed}); using the configured CLI ${configured}`);
  } else if (!removed.length) {
    claudePath = find(env[key] ?? "");
  } else {
    try { claudePath = find(env[key] ?? ""); }
    catch (error) { log(`[host] looking for claude without the stale PATH entries failed (${errorText(error)})`); }
    if (claudePath) log(`[host] dropped ${removed.length} stale Claude Desktop CLI directories from PATH (${listed}); using ${claudePath}`);
    else {
      env[key] = original;
      log(`[host] no claude found once ${removed.length} Claude Desktop CLI directories were dropped from PATH (${listed}); PATH restored as it was, looking again`);
      claudePath = find(original ?? "");
      log(`[host] ${claudePath ? `using ${claudePath} (found on the original PATH)` : "no claude found on the original PATH either"}`);
    }
  }
  putClaudeOnPath(env, claudePath, platform);
  return claudePath;
}

/** After `claude` is found: its directory leads the host's PATH, so the CLI's own children (and a later `claude` lookup) agree with the launcher in use. */
export function putClaudeOnPath(env: PathEnv, claudePath: string | undefined, platform: NodeJS.Platform = process.platform): void {
  if (!claudePath) return;
  const key = pathKey(env, platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const dir = (platform === "win32" ? path.win32 : path.posix).dirname(claudePath);
  const same = (entry: string): boolean => platform === "win32" ? entry.toLowerCase() === dir.toLowerCase() : entry === dir;
  env[key] = [dir, ...(env[key] ?? "").split(delimiter).filter(entry => entry && !same(entry))].join(delimiter);
}

export interface Paths { home: string; plist: string; log: string }
export function paths(home = os.homedir()): Paths {
  return { home, plist: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`), log: path.join(home, ".clauderipple", "logs", "host.log") };
}

export function specFor(opts: { script: string; claudePath: string | undefined; node?: string; home?: string; remoteHome?: string; log?: (line: string) => void }): PlistSpec {
  const node = opts.node ?? process.execPath;
  const p = paths(opts.home);
  return {
    node,
    script: opts.script,
    // installCmd already persists the selected bind in host.json. Repeating it here would
    // overwrite a dashboard change every time launchd restarts the host.
    args: [],
    // The checkout, so relative paths in logs read naturally; modules resolve from the script itself.
    workingDir: path.resolve(path.dirname(opts.script), "..", "..", ".."),
    log: p.log,
    env: {
      PATH: agentPath(opts.claudePath, node, opts.log ? { log: opts.log } : {}),
      HOME: p.home,
      ...(process.platform === "win32" ? { USERPROFILE: p.home } : {}),
      CLAUDERIPPLE_HOME: process.env.CLAUDERIPPLE_HOME ?? path.join(p.home, ".clauderipple"),
      ...(opts.remoteHome ? { RIPPLE_REMOTE_HOME: opts.remoteHome } : {}),
    },
  };
}

export type Run = (cmd: string, args: string[]) => { status: number; out: string };
const runSync: Run = (cmd, args) => {
  try { return { status: 0, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const domain = (): string => `gui/${process.getuid?.() ?? 501}`;

export function install(spec: PlistSpec, run: Run = runSync, p: Paths = paths()): string[] {
  return withServiceFile(p.plist, run, guard => {
    run = guard.run;
    const previous = readServiceFile(p.plist);
    if (previous !== null && ownerOf(plistEnvironment(previous).CLAUDERIPPLE_HOME ?? null, spec.env.CLAUDERIPPLE_HOME ?? "").state !== "ours") {
      throw new Error("휴대폰 호스트 서비스의 설치 소유권을 확인할 수 없어 기존 정의를 보존했습니다.");
    }
    const done: string[] = [];
    fs.mkdirSync(path.dirname(spec.log), { recursive: true, mode: 0o700 });
    const lookup = run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]);
    if (lookup.status !== 0 && lookup.status !== 113 && !/could not find service|service .*not found/i.test(lookup.out)) throw new Error("휴대폰 호스트의 서비스 상태를 확인하지 못해 서비스 정의를 보존했습니다.");
    // A loaded job with no definition is not evidence that this installation owns it.
    if (lookup.status === 0) {
      if (previous === null) throw new Error("휴대폰 호스트 서비스의 설치 소유권을 확인할 수 없어 기존 정의를 보존했습니다.");
      const stopped = run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]);
      if (stopped.status !== 0 && stopped.status !== 113) throw new Error("휴대폰 호스트의 서비스를 해제하지 못해 서비스 정의를 보존했습니다.");
      done.push("stopped the running agent");
    }
    guard.write(plist(spec), 0o644);
    done.push(`wrote ${p.plist}`);
    // The old agent may still be tearing down. Recheck the generation after every wait.
    let r = run("/bin/launchctl", ["bootstrap", domain(), p.plist]);
    for (let tries = 1; r.status === 5 && tries < 10; tries++) {
      run("/bin/sleep", ["0.5"]);
      r = run("/bin/launchctl", ["bootstrap", domain(), p.plist]);
    }
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed (${r.status}): ${r.out.trim()}`);
    done.push(`loaded ${LABEL}; logs in ${spec.log}`);
    return done;
  });
}

export type ServiceRemoval = { state: "removed" | "absent"; lines: string[] } | { state: "lookup-failed" | "stop-failed"; detail: string };

export function uninstall(run: Run = runSync, p: Paths = paths(), expected?: string | null): ServiceRemoval {
  return withServiceFile(p.plist, run, guard => {
    run = guard.run;
    if (expected !== undefined) assertGeneration(() => readServiceFile(p.plist), definitionGeneration(expected));
    const done: string[] = [];
    const missing = (r: { status: number; out: string }) => r.status === 113 || /could not find service|service .*not found/i.test(r.out);
    const lookup = run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]);
    if (lookup.status !== 0 && !missing(lookup)) return { state: "lookup-failed", detail: "휴대폰 호스트의 서비스 상태를 확인하지 못해 서비스 정의를 보존했습니다." };
    if (lookup.status === 0) {
      const r = run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]);
      if (r.status !== 0 && !missing(r)) return { state: "stop-failed", detail: "휴대폰 호스트의 서비스를 해제하지 못해 서비스 정의를 보존했습니다." };
      done.push(`stopped ${LABEL}`);
    } else done.push(`${LABEL} was not loaded`);
    if (readServiceFile(p.plist) === null) return { state: "absent", lines: done };
    guard.remove();
    done.push(`removed ${p.plist}`);
    return { state: "removed", lines: done };
  });
}

/** `launchctl print` is not a stable interface; only the two lines a person needs are read, and the raw state is shown as is. */
export function parseLaunchctlPrint(out: string): { state: string | null; pid: number | null; lastExit: string | null } {
  const m = (re: RegExp): string | null => re.exec(out)?.[1]?.trim() ?? null;
  const pid = m(/^\s*pid = (\d+)/m);
  return { state: m(/^\s*state = (.+)$/m), pid: pid ? Number(pid) : null, lastExit: m(/^\s*last exit code = (.+)$/m) };
}

export function agentStatus(run: Run = runSync, p: Paths = paths()): { installed: boolean; loaded: boolean; state: string | null; pid: number | null; lastExit: string | null } {
  const r = run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]);
  const parsed = r.status === 0 ? parseLaunchctlPrint(r.out) : { state: null, pid: null, lastExit: null };
  return { installed: fs.existsSync(p.plist), loaded: r.status === 0, ...parsed };
}
