// Client-only Remote Control transport. Never register or attach a desktop worker.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { InputBlock } from "./images.ts";
import type { Effort, PermissionMode } from "./protocol.ts";
import { OutcomeUnknownError } from "./receipts.ts";

/** CLI wire uses snake_case; older bridge shapes used camelCase. Conflicts fail closed. */
export function permissionSuppression(request: Record<string, unknown>): unknown {
  const wire = request.suppress_always_allow_rule, legacy = request.suppressAlwaysAllowRule;
  if (wire === true || legacy === true) return true;
  return wire ?? legacy;
}

export interface BridgePermissionRequest {
  requestId: string; tool: string; input: Record<string, unknown>; toolUseId: string;
  permissionSuggestions?: unknown;
  suppressAlwaysAllowRule?: unknown;
}
type SettingRequest = { subtype: "set_model"; model: string }
  | { subtype: "apply_flag_settings"; settings: { effortLevel: Effort | null } }
  | { subtype: "set_permission_mode"; mode: PermissionMode };
interface ControlWaiter { sessionId: string; fingerprint: string; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }

export const DESKTOP_BLOCKED = "Claude 앱에서 이 세션의 Remote Control을 켜거나 세션을 종료한 뒤 다시 보내 주세요. 대화 기록 충돌을 방지하기 위해 전송하지 않았습니다.";
export const DESKTOP_WAITING = "Claude 앱에서 이 세션의 Remote Control을 켜거나 세션을 종료해 주세요. 전송할 수 있게 되면 대기 중인 메시지가 자동으로 전송됩니다.";
/** The desktop still owns the transcript, but exposes no client transport. Never start a second writer. */
export class DesktopBlockedError extends Error {
  constructor() { super(DESKTOP_BLOCKED); }
}
export const DESKTOP_BUSY = "Claude 앱에서 이 세션의 작업이 진행 중입니다. 작업이 완료되면 대기 중인 메시지가 자동으로 전송됩니다.";
/** The app is running a turn in a session the host may otherwise resume: wait, never write beside it. */
export class DesktopBusyError extends DesktopBlockedError {
  constructor() { super(); this.message = DESKTOP_BUSY; }
}
export const LOGIN_EXPIRED = "이 컴퓨터의 Claude 로그인이 만료되었습니다. Claude 앱을 한 번 열어 주십시오.";
export const LOGIN_REFUSED = "이 컴퓨터의 Claude 로그인이 거절되었습니다 (401). Claude 앱을 한 번 열어 주십시오.";
// The Claude Code CLI has no login of its own. The host starts the CLI through the Agent SDK and
// passes no credential, so the CLI's own "Not logged in · Please run /login" is the whole error a
// phone sees; this says it in the host's words (issue #71).
export const CLI_NOT_LOGGED_IN = "이 컴퓨터의 Claude Code에 로그인되어 있지 않습니다. 터미널에서 Claude Code를 한 번 실행해 /login 해 주십시오.";
/** The CLI's own words for the same thing, tolerant of the spacing around them. */
export function isCliNotLoggedIn(text: string): boolean {
  return /^\s*not\s+logged\s+in\b/i.test(text);
}
/**
 * The CLI's words when its own login cannot be used, wherever they land in a longer message (a
 * result's `errors` are joined): "Not logged in · Please run /login", and the expired-OAuth line,
 * both of which tell the person to run /login.
 */
export function isLoginRefusal(text: string): boolean {
  return isCliNotLoggedIn(text) || /please\s+run\s+\/login\b/i.test(text);
}
export interface BridgeAuth { accessToken: string; organizationUuid: string; accountUuid?: string; expiresAt: number }
class BridgeNetworkError extends Error {}
class BridgeHttpError extends Error {
  status: number;
  constructor(status: number) { super(status >= 500 ? `Claude 앱 요청 중 오류가 발생했습니다 (${status}).` : `Claude 앱이 메시지를 받지 않았습니다 (${status}).`); this.status = status; }
}
export function bridgeWriteUnknown(error: unknown): boolean {
  return error instanceof BridgeNetworkError || error instanceof BridgeHttpError && error.status >= 500;
}
/** Only an unavailable login or an explicit client error proves a session was not created. */
export function bridgeCreateNotCreated(error: unknown): boolean {
  return error instanceof BridgeAuthError || error instanceof BridgeHttpError && error.status >= 400 && error.status < 500;
}
/**
 * This Mac's Claude login cannot be used (expired, unreadable, or refused): nothing reaches any
 * Claude app session until Claude Code refreshes it, which the host never does itself. A state of
 * the whole host, not of one session, so phones are told once rather than per request.
 */
export class BridgeAuthError extends Error {}
/** While the login is expired, the keychain is read again at most this often (a child process each time). */
export const AUTH_REREAD_MS = 30_000;
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** A Claude app login the router saw this long ago still counts as current. */
export const OBSERVED_FRESH_MS = 6 * 3_600_000;
/** How long an observed login is trusted before it is read again (its own expiry is not visible). */
export const OBSERVED_TTL_MS = 10 * 60_000;

/**
 * The login the Claude app itself is using right now, as the router last saw it on a request it
 * carried (router observedClaudeCodeAuth, `claude-auth-observed.json`), or null when there is none
 * recent. The keychain item belongs to the `claude` CLI and is refreshed only while the CLI runs:
 * working in the desktop app alone left it expired, then emptied (accessToken "", expiresAt 0,
 * 2026-10-20 21:28), and the phone was told the login had expired while the app worked fine.
 */
export function loadObservedAuth(now = Date.now(), home = process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple")): { accessToken: string; expiresAt: number } | null {
  try {
    const seen = object(JSON.parse(fs.readFileSync(path.join(home, "claude-auth-observed.json"), "utf8")));
    const token = typeof seen?.authorization === "string" ? /^Bearer\s+(\S+)$/.exec(seen.authorization)?.[1] : undefined;
    if (!token || typeof seen?.observedAt !== "number" || now - seen.observedAt > OBSERVED_FRESH_MS) return null;
    return { accessToken: token, expiresAt: now + OBSERVED_TTL_MS };
  } catch { return null; }
}

export interface BridgeAuthOptions {
  platform?: NodeJS.Platform;
  /** The user's home directory: `.claude.json` and `.claude/.credentials.json` live in it. */
  userHome?: string;
  now?: number;
  /** Reads a file. The macOS keychain is not a file and is read on its own. */
  readFile?: (file: string) => string;
  /** The login the router saw the Claude app use. */
  observed?: (now: number) => { accessToken: string; expiresAt: number } | null;
  /** The Claude Code CLI's own login: the macOS keychain item, the Windows credentials file. */
  cli?: () => { accessToken: string; expiresAt: number } | null;
}

/** The Claude Code CLI's own login on macOS: the keychain item the CLI writes. */
function keychainCredentials(): { accessToken: string; expiresAt: number } | null {
  try {
    const credentials = object(JSON.parse(execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? os.userInfo().username, "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
    const oauth = object(credentials?.claudeAiOauth);
    if (typeof oauth?.accessToken === "string" && oauth.accessToken && typeof oauth.expiresAt === "number") return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch { /* the observed login may still serve */ }
  return null;
}

/**
 * The Claude Code CLI's own login on Windows: `%USERPROFILE%\.claude\.credentials.json`. There is
 * no keychain there, and the Claude app on its own keeps no credentials file of its own: it
 * injects the login into the CLI it starts (issue #70).
 */
function windowsCredentials(read: (file: string) => string, userHome: string): { accessToken: string; expiresAt: number } | null {
  try {
    const credentials = object(JSON.parse(read(path.join(userHome, ".claude", ".credentials.json"))));
    const oauth = object(credentials?.claudeAiOauth);
    if (typeof oauth?.accessToken === "string" && oauth.accessToken && typeof oauth.expiresAt === "number") return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch { /* the observed login may still serve */ }
  return null;
}

export function loadBridgeAuth(options: BridgeAuthOptions = {}): BridgeAuth {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error(DESKTOP_BLOCKED);
  const now = options.now ?? Date.now();
  const userHome = options.userHome ?? os.homedir();
  const read = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  let organizationUuid: string;
  let accountUuid: string | undefined;
  try {
    const account = object(object(JSON.parse(read(path.join(userHome, ".claude.json"))))?.oauthAccount);
    if (typeof account?.organizationUuid !== "string") throw new Error();
    organizationUuid = account.organizationUuid;
    if (typeof account.accountUuid === "string" && account.accountUuid) accountUuid = account.accountUuid;
  } catch { throw new BridgeAuthError("이 컴퓨터의 Claude 로그인 정보를 읽을 수 없습니다."); }
  // The CLI's own login: the macOS keychain item, or the credentials file Windows keeps.
  const cli = options.cli ? options.cli() : platform === "darwin" ? keychainCredentials() : windowsCredentials(read, userHome);
  // The CLI's login while it is good; else the one the Claude app is working with; else the
  // CLI's expired one, so the phone is told it expired.
  const identity = { organizationUuid, ...(accountUuid ? { accountUuid } : {}) };
  if (cli && cli.expiresAt - now > 5 * 60_000) return { ...cli, ...identity };
  const observed = options.observed ? options.observed(now) : loadObservedAuth(now);
  if (observed) return { ...observed, ...identity };
  if (cli) return { ...cli, ...identity };
  throw new BridgeAuthError(LOGIN_EXPIRED);
}
export interface BridgeFrame { event: string; data: Record<string, unknown> }

// TEMPORARY PROBE, measurement only (2026-11-10): removed by the follow-up commit. It counts Remote Control frame
// kinds, payload sizes and the paths of text-like keys, and the gaps between frames that carry them. It never
// logs a value, an id or text. One summary line a minute goes to stderr.
const PROBE_WINDOW_MS = 60_000;
const probe = { start: Date.now(), last: 0, frames: new Map<string, number>(), sizes: new Map<string, number>(), paths: new Map<string, number>(), gaps: [] as number[] };
const PROBE_NAME = /^[a-z][a-z_]{0,39}$/;
function probeCount(map: Map<string, number>, key: string): void { map.set(key, (map.get(key) ?? 0) + 1); }
function probePaths(value: unknown, path: string, depth: number, out: Set<string>): void {
  if (depth > 5 || value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = `${path}.${PROBE_NAME.test(key) ? key : "*"}`;
    if (/delta|text|partial/i.test(key)) out.add(next);
    probePaths(child, next, depth + 1, out);
  }
}
function probeFlush(now: number): void {
  const gaps = [...probe.gaps].sort((a, b) => a - b);
  const at = (p: number) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : null);
  process.stderr.write(`[probe] ${JSON.stringify({ windowS: Math.round((now - probe.start) / 1000), frames: Object.fromEntries(probe.frames), bytes: Object.fromEntries(probe.sizes), textPaths: Object.fromEntries(probe.paths), textGapMs: { n: gaps.length, p50: at(0.5), p90: at(0.9), max: gaps.at(-1) ?? null } })}\n`);
  probe.start = now;
  probe.frames.clear(); probe.sizes.clear(); probe.paths.clear(); probe.gaps = [];
}
function probeFrame(frame: BridgeFrame): void {
  try {
    const now = Date.now();
    const payload = frame.data.payload as { type?: unknown } | undefined;
    const typed = payload && typeof payload === "object" && typeof payload.type === "string" ? payload.type : undefined;
    probeCount(probe.frames, `${frame.event}|${typed === undefined ? "none" : PROBE_NAME.test(typed) ? typed : "other"}`);
    const bytes = JSON.stringify(frame.data).length;
    probeCount(probe.sizes, `${frame.event}|${bytes < 256 ? "<256" : bytes < 1024 ? "<1k" : bytes < 4096 ? "<4k" : bytes < 16384 ? "<16k" : bytes < 65536 ? "<64k" : ">=64k"}`);
    const found = new Set<string>();
    probePaths(frame.data, frame.event, 0, found);
    if (found.size) {
      for (const path of found) probeCount(probe.paths, path);
      if (probe.last) probe.gaps.push(now - probe.last);
      probe.last = now;
    }
    if (now - probe.start >= PROBE_WINDOW_MS) probeFlush(now);
  } catch { /* the probe never breaks the stream */ }
}
/** `slash_commands` minus `terminal_slash_commands`, which phone UIs should hide (SDK init docs). */
export function slashCommands(init: Record<string, unknown>): string[] | null {
  if (!Array.isArray(init.slash_commands)) return null;
  const terminal = new Set(Array.isArray(init.terminal_slash_commands) ? init.terminal_slash_commands : []);
  return init.slash_commands.filter((c): c is string => typeof c === "string" && !!c && !terminal.has(c));
}

export class BridgeClient {
  private fetchFn: typeof fetch;
  private loadAuth: () => BridgeAuth;
  private cached: BridgeAuth | null = null;
  private readAt = 0;
  /** What the last read threw, kept with `readAt` so the same failure answers requests for one window. */
  private readFailure: { error: unknown } | null = null;
  private now: () => number;
  constructor(options: { fetch?: typeof fetch; auth?: () => BridgeAuth; now?: () => number } = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.loadAuth = options.auth ?? loadBridgeAuth;
    this.now = options.now ?? Date.now;
  }
  /**
   * The keychain read is a synchronous child process; doing it per request blocked the host's
   * event loop under the 3 s state poll until relay pings timed out (2026-10-12). Kept in memory
   * and reread only near expiry or after a 401 (Claude Code refreshes the token on its own) — and
   * near or past expiry at most every AUTH_REREAD_MS: an expired login otherwise meant one keychain
   * read per request, every poll, for as long as it stayed expired (2026-10-15). A read that fails
   * outright is kept the same way — its time and the error it threw — so twenty sessions failing at
   * the same moment read the login once and each is given that error: no invented login, and no
   * second keychain read until the window is up (2026-10-25). A login written later (Claude Code
   * refreshing its own, or a restarted host with a new client) is read at the next request at or
   * after the window; a 401 drops the kept failure so the next request reads it at once.
   */
  private auth(): BridgeAuth {
    const now = this.now();
    const stale = !this.cached || this.refused || this.cached.expiresAt - now < 5 * 60_000;
    // The first read is forced; after that only the window decides, including while the read fails.
    if (stale && ((!this.cached && !this.readFailure) || now - this.readAt >= AUTH_REREAD_MS)) this.read(now);
    if (this.readFailure) throw this.readFailure.error;
    return this.cached!;
  }
  /** One read of this host's login, and the outcome kept as this client's; it is never shared. */
  private read(now: number): void {
    this.readAt = now;
    this.readFailure = null;
    try {
      this.cached = this.loadAuth();
      this.refused = false;
    } catch (error) {
      this.cached = null;
      this.readFailure = { error };
    }
  }
  /** Forget the read so the next request reads the login again at once (the 401 path). */
  private forget(): void {
    this.cached = null;
    this.readFailure = null;
  }
  /** The API answered 401 to the token in `cached`; cleared when the keychain is read again. */
  private refused = false;
  private async request(id: string | null, suffix: string, options: RequestInit): Promise<Response> {
    const auth = this.auth();
    if (this.refused) throw new BridgeAuthError(LOGIN_REFUSED);
    if (auth.expiresAt <= this.now()) throw new BridgeAuthError(LOGIN_EXPIRED);
    let response: Response;
    try {
      // The bridge treats a prompt as the user's own only from a person's app platform
      // (ios, android, web_claude_ai, desktop_app in CLI 2.1.296); any claude_code_* platform
      // is demoted to "a message from another Claude session". These prompts are typed on a phone.
      response = await this.fetchFn(`https://api.anthropic.com/v1/code/sessions${id === null ? "" : `/${encodeURIComponent(id)}`}${suffix}`, {
        ...options, redirect: "error", headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-version": "2023-06-01", "anthropic-client-platform": "ios", "x-organization-uuid": auth.organizationUuid, "Content-Type": "application/json", "User-Agent": "RippleRemote/0.8.10" },
      });
    } catch { throw new BridgeNetworkError("Claude 앱과 연결하지 못했습니다."); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) {
        // Refused: the keychain is read again (Claude Code may have refreshed it) — at once if the
        // last read is AUTH_REREAD_MS old, else then; until then requests fail here without a call.
        if (this.now() - this.readAt >= AUTH_REREAD_MS) this.forget();
        else this.refused = true;
        throw new BridgeAuthError(LOGIN_REFUSED);
      }
      // Do not expose server bodies (which may echo credentials), or retry rejected writes.
      throw new BridgeHttpError(response.status);
    }
    return response;
  }
  /** The organization used by the next bridge request; no credential leaves this client. */
  identity(): Pick<BridgeAuth, "organizationUuid" | "accountUuid"> {
    const { organizationUuid, accountUuid } = this.auth();
    return { organizationUuid, ...(accountUuid ? { accountUuid } : {}) };
  }

  /** A lost response does not prove a POST did nothing (ARCHITECTURE.md:1760). Never retry it. */
  async createEnvironmentSession(environmentId: string, title: string): Promise<string> {
    const response = await this.request(null, "", { method: "POST", body: JSON.stringify({ title, events: [], environment_id: environmentId, config: { sources: [] } }), signal: AbortSignal.timeout(15_000) });
    let body: Record<string, unknown> | null;
    try { body = object(await response.json()); }
    catch { throw new Error("Claude app session creation response could not be read."); }
    const id = object(body?.session)?.id ?? body?.id;
    if (typeof id !== "string" || !/^cse_[\w-]+$/.test(id)) throw new Error("Claude app session creation response has no valid session id.");
    return id;
  }
  async post(id: string, payload: Record<string, unknown>): Promise<void> {
    const response = await this.request(id, "/events", { method: "POST", body: JSON.stringify({ session_id: id, events: [{ payload }] }), signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
  }
  send(id: string, uuid: string, content: string | InputBlock[]): Promise<void> {
    return this.post(id, { type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null });
  }
  interrupt(id: string): Promise<void> {
    return this.post(id, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }
  private controls = new Map<string, ControlWaiter>();

  /** Register before POST: a worker may answer before the HTTP acknowledgement arrives.
   * Ambiguous network failures keep waiting. No write here is ever retried. */
  control(id: string, requestId: string, request: SettingRequest): Promise<void> {
    const key = JSON.stringify([id, requestId]);
    const fingerprint = JSON.stringify(request);
    const previous = this.controls.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.reject(new Error("Control request id reused"));
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.controls.set(key, { sessionId: id, fingerprint, promise, resolve, reject });
    void this.post(id, { type: "control_request", request_id: requestId, request }).catch((error: unknown) => {
      // A reset/timeout does not prove the CLI did not apply the setting. Reconnect reads
      // its durable response; a definite HTTP refusal can reject immediately.
      if (!bridgeWriteUnknown(error)) reject(error instanceof Error ? error : new Error(String(error)));
    });
    return promise;
  }

  /** True only for OUR setting request, from the worker. Approval answers are separate. */
  controlResponse(id: string, source: unknown, payload: Record<string, unknown>): boolean {
    if (source !== "worker" || payload.type !== "control_response") return false;
    const response = object(payload.response);
    if (typeof response?.request_id !== "string") return false;
    const waiter = this.controls.get(JSON.stringify([id, response.request_id]));
    if (!waiter) return false;
    const body = object(response.response);
    if (response.verdict_pending === true || body?.verdict_pending === true || response.subtype === "verdict_pending" || body?.status === "verdict_pending") return true;
    if (response.subtype === "success") waiter.resolve();
    else if (response.subtype === "error") {
      const error = object(response.error);
      const detail = typeof response.error === "string" ? response.error : typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : "설정 변경이 거절되었습니다";
      waiter.reject(new Error(detail.slice(0, 1000)));
    }
    return true;
  }

  /** A replaced worker's unanswered writes are unknown, never replayed on its replacement.
   * Keep their settled promises until shutdown so reusing an id cannot send the write again. */
  closeControls(id?: string): void {
    for (const waiter of this.controls.values()) {
      if (id === undefined || waiter.sessionId === id) waiter.reject(new OutcomeUnknownError());
    }
    if (id === undefined) this.controls.clear();
  }

  async session(id: string): Promise<{ worker_status: "running" | "idle" | "requires_action"; status?: string; status_bucket?: string; connection_status?: string }> {
    const response = object(await (await this.request(id, "", { method: "GET", signal: AbortSignal.timeout(3000) })).json());
    // CLI 2.1.296's single-session read uses response_shape ?? session.
    const body = object(response?.response_shape ?? response?.session) ?? response;
    const worker_status = body?.worker_status;
    if (worker_status !== "running" && worker_status !== "idle" && worker_status !== "requires_action") throw new Error("Remote Control session has no valid worker status.");
    return { worker_status, ...(typeof body?.status === "string" ? { status: body.status } : {}),
      ...(typeof body?.status_bucket === "string" ? { status_bucket: body.status_bucket } : {}),
      ...(typeof body?.connection_status === "string" ? { connection_status: body.connection_status } : {}) };
  }
  async events(id: string): Promise<Record<string, unknown>> {
    return object(await (await this.request(id, "/events?sort_order=asc", { signal: AbortSignal.timeout(15_000) })).json()) ?? {};
  }
  /** The session's slash commands, from the CLI's init event, without the terminal-only ones; null when it has none. */
  async commands(id: string): Promise<string[] | null> {
    const list = (await this.events(id)).data;
    for (const value of Array.isArray(list) ? list : []) {
      const payload = object(object(value)?.payload);
      if (payload?.type === "system" && payload.subtype === "init") return slashCommands(payload);
    }
    return null;
  }
  /**
   * Authorization requests still open on the session, oldest first. The stream starts at the
   * newest event (`latest` below), so attach and every reconnect replay this list from the start
   * cursor instead — otherwise an approval requested before the stream connected never cards.
   * A request followed by its control_response (answered from another client) or
   * control_cancel_request (withdrawn) is not open and is left out.
   * Null when the answer carried no event list: that is not "nothing is open", and a caller
   * must not close pending cards on it.
   */
  async openRequests(id: string): Promise<BridgePermissionRequest[] | null> {
    return (await this.requests(id))?.open ?? null;
  }
  /**
   * The open requests, and the ids this read saw answered or withdrawn. A request merely missing
   * from the list proves nothing (the list may not reach that far), so only `closed` may close a
   * card the phone still shows.
   */
  async requests(id: string): Promise<{ open: BridgePermissionRequest[]; closed: Set<string> } | null> {
    const list = (await this.events(id)).data;
    if (!Array.isArray(list)) return null;
    const open = new Map<string, BridgePermissionRequest>();
    const closed = new Set<string>();
    for (const value of list) {
      const item = object(value);
      const payload = object(item?.payload);
      if (!payload) continue;
      if (this.controlResponse(id, item?.source, payload)) continue;
      // A control_request names its request at the top; a control_response posted by this host (or
      // by the desktop app) carries it under `response`. Reading only the top-level id left every
      // answered request listed as open, so a replay an hour later carded it again (issue #82).
      const nested = object(payload.response)?.request_id;
      const requestId = typeof payload.request_id === "string" ? payload.request_id : typeof nested === "string" ? nested : "";
      if (!requestId) continue;
      if (payload.type === "control_request") {
        // Stored prompts carry the same source as stream frames; accept a missing one, never a foreign one.
        const source = (item as { source?: unknown } | null)?.source;
        if (source !== undefined && source !== "worker") continue;
        const request = object(payload.request);
        const input = object(request?.input);
        if (request?.subtype === "can_use_tool" && typeof request.tool_name === "string" && input && typeof request.tool_use_id === "string") {
          open.set(requestId, { requestId, tool: request.tool_name, input, toolUseId: request.tool_use_id,
            ...(request.permission_suggestions !== undefined ? { permissionSuggestions: request.permission_suggestions } : {}),
            ...(permissionSuppression(request) !== undefined ? { suppressAlwaysAllowRule: permissionSuppression(request) } : {}) });
        }
      } else if (payload.type === "control_response" || payload.type === "control_cancel_request") {
        // Any client's answer or withdrawal closes it: this host's own answer is stored with the
        // posting client's source, and it must still count as answered (issue #82).
        open.delete(requestId);
        closed.add(requestId);
      }
    }
    return { open: [...open.values()], closed };
  }
  /** The newest durable event's number; the stream starts there instead of replaying the whole session. */
  private async latest(id: string, signal: AbortSignal): Promise<number> {
    const body = object(await (await this.request(id, "/events?sort_order=desc&limit=1", { signal })).json());
    const first = Array.isArray(body?.data) ? object(body.data[0]) : null;
    return sequenceOf(first?.sequence_num) ?? 0;
  }
  async stream(id: string, signal: AbortSignal, handle: (frame: BridgeFrame) => void, onConnect?: () => void): Promise<void> {
    let sequence: number | null = null;
    while (!signal.aborted) {
      if (sequence === null) {
        try { sequence = await this.latest(id, signal); }
        catch (error) {
          if (signal.aborted) return;
          if (!(error instanceof BridgeNetworkError)) throw error;
          await delay(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
          continue;
        }
      }
      let response: Response;
      try { response = await this.request(id, `/events/stream?from_sequence_num=${sequence}`, { signal }); }
      catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof BridgeNetworkError)) throw error;
        await delay(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
        continue;
      }
      if (!response.body) throw new Error("Remote Control stream is empty.");
      // Connected (or reconnected): the caller replays approvals already waiting, which the
      // newest-event cursor above would otherwise skip.
      onConnect?.();
      let handling = false;
      try {
        for await (const frame of decodeSse(response.body)) {
          probeFrame(frame);
          handling = true;
          // Only live permission prompts come from here; the conversation itself is read from the transcript.
          if (frame.event === "catch_up_truncated") { handling = false; continue; }
          const number = sequenceOf(frame.data.sequence_num);
          if (frame.event === "client_event" && number !== undefined) {
            if (number <= sequence) { handling = false; continue; }
            handle(frame);
            sequence = number;
          } else if (frame.event === "ephemeral_event") handle(frame);
          handling = false;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (handling) throw error;
        // A broken read reconnects; HTTP rejection above is terminal. Writes are never retried.
      }
      await delay(1000, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  }
}

/** The server sends sequence numbers as decimal strings ("9136"); tests and older shapes use numbers. */
function sequenceOf(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export async function* decodeSse(body: ReadableStream<Uint8Array>): AsyncGenerator<BridgeFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "", event = "", data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 4 * 1024 * 1024) throw new Error("Remote Control frame too large.");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (!line) {
          if (data.length) {
            const parsed = object(JSON.parse(data.join("\n")));
            if (parsed) yield { event, data: parsed };
          }
          event = ""; data = [];
        }
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
