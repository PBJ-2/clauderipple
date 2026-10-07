// Grok subscription sign-in, borrowed from the Grok CLI. Nothing here signs anyone in.
//
//   <grok home>/auth.json   written by `grok login` ($GROK_HOME, else ~/.grok). One entry per issuer,
//                           keyed `https://auth.x.ai::<id>`; each has `key` (the session token, sent
//                           as a bearer), `expires_at` (RFC 3339) and a `refresh_token`.
//
// Read-only, for the same reason as `borrow-codex`: the CLI refreshes its grant under a lock of its
// own (`auth lock` in ~/.grok/logs), and if that refresh rotates the refresh token — not measured —
// refreshing it from here would race the CLI and could sign it out. Measured 2026-10-08 on CLI 1.0.46: a session token lives six hours, and a running
// CLI refreshes it about five minutes before expiry (`GROK_AUTH_EARLY_INVALIDATION_SECS`, default 300).
// With no CLI running the file simply goes stale. So when the token is near its end the router asks
// the CLI to do it: `grok models` with that same variable set to our own threshold makes the CLI see
// the token as expiring, refresh it under its lock, and write the file — which we then read again.
// `grok models` was measured to do exactly this (expiry moved six hours, file rewritten).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type GrokToken = {
  key: string;
  /** epoch ms; 0 when the file states none */
  expiresAt: number;
  email?: string;
};

/** `x-grok-client-version` when the CLI cannot be asked. The proxy refuses a request without one (426). */
export const GROK_CLIENT_VERSION_FALLBACK = "1.0.46";

/** What the user can do about a missing or rejected session, appended to the errors they read. */
export const GROK_AUTH_HINT = "sign in with `grok login`, or run `grok` once so the CLI refreshes its session";

export function grokHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GROK_HOME ? env.GROK_HOME : path.join(os.homedir(), ".grok");
}

export function grokAuthPath(home: string): string {
  return path.join(home, "auth.json");
}

/**
 * The session token in `file`: of the entries carrying one, the one that expires last. The entry key
 * is the issuer plus an id, and the CLI's own README reads a different key than the one it writes
 * (`https://accounts.x.ai/sign-in` vs `https://auth.x.ai::…`, 1.0.46), so no key is assumed.
 */
export function readGrokToken(file: string): GrokToken | null {
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  let best: GrokToken | null = null;
  for (const value of Object.values(doc as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { key?: unknown; expires_at?: unknown; email?: unknown };
    if (typeof entry.key !== "string" || !entry.key) continue;
    const expiresAt = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) || 0 : 0;
    if (best && expiresAt <= best.expiresAt) continue;
    best = { key: entry.key, expiresAt, ...(typeof entry.email === "string" ? { email: entry.email } : {}) };
  }
  return best;
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The `grok` binary. The router runs under launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin (measured
 * 2026-10-08), where the CLI never is, so the installer's own location comes before PATH.
 */
export function findGrokCli(home: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit) return executable(explicit) ? explicit : null;
  const name = process.platform === "win32" ? "grok.exe" : "grok";
  const candidates = [
    path.join(home, "bin", name),
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
    path.join(env.HOME || os.homedir(), ".local", "bin", name),
  ];
  return candidates.find(executable) ?? null;
}

export type RunCli = (file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;

const runCli: RunCli = (file, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(String(stdout));
  });
});

export class GrokAuthError extends Error {}

export type GrokAuthOptions = {
  home: string;
  /** Explicit `grok` binary; otherwise found with `findGrokCli`. */
  cli?: string;
  /** Explicit `x-grok-client-version`; otherwise what `grok --version` prints. */
  clientVersion?: string;
  log: { info(msg: string): void; warn(msg: string): void };
  /** Refresh a token with less than this left. Default 10 minutes. */
  refreshAheadMs?: number;
  /** Test seams. */
  run?: RunCli;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Bounded by the CLI's own: it waits up to 25s for its auth lock (`auth lock: attempting acquire
 * (timeout=25000ms)`), so a refresh that cannot finish in 30s is not going to.
 */
const REFRESH_TIMEOUT_MS = 30_000;
/**
 * A rejected token is not ours to keep, so the refresh that follows one treats whatever is there as
 * expiring. A day is past any session's six hours, and is the value measured to make the CLI refresh.
 */
const FORCE_REFRESH_SECS = 24 * 3600;
/**
 * A proxy that keeps refusing a freshly minted token is refusing the account, not the token, and
 * forcing a refresh for every turn would only churn the grant. The CLI's README states the same rule
 * for its own credential helpers: a token rejected within 30s of being fetched is not fetched again.
 */
const FORCED_REFRESH_GAP_MS = 60_000;
/**
 * A proactive refresh that ran and still left the token short (the CLI failed, or the IdP is down) is
 * not run again for every turn in the minutes the token has left: each run can take 30s.
 */
const REFRESH_RETRY_GAP_MS = 60_000;

export class GrokAuth {
  readonly file: string;
  private readonly opts: GrokAuthOptions;
  private readonly refreshAheadMs: number;
  private readonly run: RunCli;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private cached: { mtimeMs: number; size: number; token: GrokToken | null } | undefined;
  private refreshing: Promise<void> | undefined;
  private lastForcedAt = -Infinity;
  private lastAttemptAt = -Infinity;
  private version: { binary: string; value: Promise<string> } | undefined;

  constructor(opts: GrokAuthOptions) {
    this.opts = opts;
    this.file = grokAuthPath(opts.home);
    this.refreshAheadMs = opts.refreshAheadMs ?? 10 * 60_000;
    this.run = opts.run ?? runCli;
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? process.env;
  }

  /** The token on disk, read again only when the file changes. One stat per call. */
  current(): GrokToken | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cached = undefined;
      return null;
    }
    if (this.cached && this.cached.mtimeMs === st.mtimeMs && this.cached.size === st.size) return this.cached.token;
    const token = readGrokToken(this.file);
    this.cached = { mtimeMs: st.mtimeMs, size: st.size, token };
    return token;
  }

  private usable(token: GrokToken | null, marginMs: number): token is GrokToken {
    return token !== null && (token.expiresAt === 0 || token.expiresAt - this.now() > marginMs);
  }

  /**
   * A token with at least `refreshAheadMs` to live, asking the CLI for a fresh one when the file's has
   * less. A token that is merely close to its end is still used when the CLI cannot refresh it: it
   * works until it expires, and refusing it early would fail a turn that could have run.
   */
  async token(): Promise<GrokToken> {
    const now = this.current();
    if (this.usable(now, this.refreshAheadMs)) return now;
    if (now === null && !fs.existsSync(this.file)) throw new GrokAuthError(`no Grok session at ${this.file}: ${GROK_AUTH_HINT}`);
    const triedJustNow = !this.refreshing && this.now() - this.lastAttemptAt < REFRESH_RETRY_GAP_MS;
    if (!(triedJustNow && this.usable(now, 0))) await this.refresh(Math.ceil(this.refreshAheadMs / 1000));
    const after = this.current();
    if (this.usable(after, 0)) return after;
    throw new GrokAuthError(`the Grok session in ${this.file} has expired: ${GROK_AUTH_HINT}`);
  }

  /**
   * After the proxy refused `key`: whether a different, live token is available now. The file is read
   * first, since the CLI may already have rotated it; only when it still holds the refused token is
   * the CLI asked to refresh, and that refresh is forced — the token was refused, however long it had.
   */
  async rejected(key: string): Promise<boolean> {
    const now = this.current();
    if (now && now.key !== key && this.usable(now, 0)) return true;
    if (this.now() - this.lastForcedAt < FORCED_REFRESH_GAP_MS) return false;
    this.lastForcedAt = this.now();
    await this.refresh(FORCE_REFRESH_SECS);
    const after = this.current();
    return after !== null && after.key !== key && this.usable(after, 0);
  }

  /** One refresh at a time: concurrent turns that all find the token stale share the CLI run. */
  private refresh(earlySecs: number): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.lastAttemptAt = this.now();
    const cli = findGrokCli(this.opts.home, this.opts.cli, this.env);
    if (!cli) {
      this.opts.log.warn(`grok: session needs a refresh but no grok CLI was found${this.opts.cli ? ` at ${this.opts.cli}` : ""}`);
      return Promise.resolve();
    }
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      GROK_AUTH_EARLY_INVALIDATION_SECS: String(earlySecs),
      // The CLI reads its session from $GROK_HOME; a home given in the config has to reach it.
      ...(this.opts.home !== grokHome(this.env) ? { GROK_HOME: this.opts.home } : {}),
    };
    const started = this.now();
    this.refreshing = this.run(cli, ["models"], env, REFRESH_TIMEOUT_MS)
      .then(() => this.opts.log.info(`grok: session refreshed through the CLI in ${this.now() - started}ms`))
      .catch((error: Error) => this.opts.log.warn(`grok: CLI session refresh failed: ${error.message.split("\n")[0]?.slice(0, 200)}`))
      .finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /**
   * `x-grok-client-version`: the installed CLI's own version, so the proxy sees the client the token
   * was issued to. Read again when the binary changes — an update replaces the file the symlink names.
   */
  clientVersion(): Promise<string> {
    if (this.opts.clientVersion) return Promise.resolve(this.opts.clientVersion);
    const cli = findGrokCli(this.opts.home, this.opts.cli, this.env);
    let binary = "";
    try { binary = cli ? fs.realpathSync(cli) : ""; } catch { /* keep the unresolved name */ }
    if (this.version && this.version.binary === binary) return this.version.value;
    const value = !cli
      ? Promise.resolve(GROK_CLIENT_VERSION_FALLBACK)
      : this.run(cli, ["--version"], this.env, 10_000)
        .then((out) => /\b(\d+\.\d+\.\d+)\b/.exec(out)?.[1] ?? GROK_CLIENT_VERSION_FALLBACK)
        .catch((error: Error) => {
          this.opts.log.warn(`grok: \`grok --version\` failed (${error.message.split("\n")[0]?.slice(0, 120)}); sending ${GROK_CLIENT_VERSION_FALLBACK}`);
          return GROK_CLIENT_VERSION_FALLBACK;
        });
    this.version = { binary, value };
    return value;
  }
}
