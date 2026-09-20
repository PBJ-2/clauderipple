// Claude subscription sign-in of our own: the OAuth authorization-code flow with PKCE that Claude
// Code itself uses, driven from ClaudeRipple so that no terminal is needed. Until 0.1.2 the only
// way to connect a subscription was `claude setup-token`, an interactive terminal flow that the
// tray app and the GUI cannot host (2026-09-15, Windows report).
//
// Wire facts are behaviorally measured against Claude Code's public client and are not an
// Anthropic guarantee (docs/ARCHITECTURE.md §4b). The browser is sent to claude.ai; the code comes
// back either to a loopback listener on the registered port or, when that port is taken, through
// the manual "paste the code" page (`code#state`). Grants are stored only in the 0600
// <home>/claude-accounts.json pool and never logged or returned by the admin API.

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { redactErrorText } from "../redact.ts";
import { saveClaudeOAuthAccount, type ClaudeAccountSummary } from "./anthropic-accounts.ts";

// Endpoints, scopes and body shapes are what Claude Code 2.1.271 sends (read from its binary on
// 2026-09-16): the claude.ai login is `claude.com/cai/oauth/authorize`, tokens come from
// `platform.claude.com`. The previous `claude.ai/oauth/authorize` answers "Invalid request format".
export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  /** The refresh grant names the subscription scopes only (as Claude Code does). */
  refreshScope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  /** Preferred loopback port; any free port is accepted by the authorize server, so a taken port falls back to a random one. */
  port: 54545,
  callbackPath: "/callback",
  /** Anthropic's own page that shows the code for pasting when no loopback listener can be reached. */
  manualRedirectUri: "https://platform.claude.com/oauth/code/callback",
  /** How long a sign-in may stay open before it is abandoned. */
  timeoutMs: 5 * 60 * 1000,
  /** Refresh this long before the access token expires. */
  refreshLeadMs: 5 * 60 * 1000,
} as const;

export type ClaudeOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
};
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ClaudeOAuthOptions = {
  home: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Test seam: listen on this port instead of the registered one (the redirect URI keeps the registered port). */
  port?: number;
  /** Skip the loopback listener and use the paste-the-code page from the start. */
  manual?: boolean;
};

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A token endpoint reply. Only the fields we use are typed; anything else is ignored. */
type TokenReply = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { uuid?: unknown; email_address?: unknown };
  error?: unknown;
  error_description?: unknown;
};

export class ClaudeOAuthTokenError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly needsReauth: boolean;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ClaudeOAuthTokenError";
    this.status = status;
    this.code = code;
    this.needsReauth = status === 400 && code !== null && /^(invalid_grant|invalid_token|access_denied|expired_token)$/.test(code);
  }
}

async function postToken(fetchImpl: FetchLike, body: Record<string, string>): Promise<TokenReply> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(`Claude token endpoint request failed: ${redactErrorText(raw, Object.values(body), 300)}`);
  }
  const text = await response.text();
  let parsed: TokenReply = {};
  try {
    parsed = JSON.parse(text) as TokenReply;
  } catch {
    // A non-JSON body is reported through the status below.
  }
  if (!response.ok) {
    const code = typeof parsed.error === "string" ? parsed.error : null;
    const rawDetail = typeof parsed.error_description === "string" ? parsed.error_description : code ?? `HTTP ${response.status}`;
    const detail = redactErrorText(rawDetail, Object.values(body), 300);
    throw new ClaudeOAuthTokenError(`Claude sign-in was refused by the token endpoint: ${detail}`, response.status, code);
  }
  return parsed;
}

function grantFrom(reply: TokenReply, now: number, previousRefresh?: string): ClaudeOAuthGrant {
  if (typeof reply.access_token !== "string" || reply.access_token.length === 0) throw new Error("Claude sign-in returned no access token");
  const refreshToken = typeof reply.refresh_token === "string" && reply.refresh_token.length > 0 ? reply.refresh_token : previousRefresh;
  if (!refreshToken) throw new Error("Claude sign-in returned no refresh token");
  // A missing or absurd expires_in is treated as one hour: better an early refresh than a token
  // believed valid forever.
  const expiresIn = typeof reply.expires_in === "number" && Number.isFinite(reply.expires_in) && reply.expires_in > 0 ? reply.expires_in : 3600;
  const accountId = typeof reply.account?.uuid === "string" && reply.account.uuid.length > 0 ? reply.account.uuid : undefined;
  const emailValue = typeof reply.account?.email_address === "string"
    ? reply.account.email_address.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 320)
    : "";
  const email = emailValue || undefined;
  return {
    accessToken: reply.access_token,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  };
}

/** Exchanges a refresh token; the caller persists the result. */
export async function refreshClaudeOAuth(refreshToken: string, options: { fetch?: FetchLike; now?: () => number } = {}): Promise<ClaudeOAuthGrant> {
  const reply = await postToken(options.fetch ?? fetch, { grant_type: "refresh_token", client_id: CLAUDE_OAUTH.clientId, refresh_token: refreshToken, scope: CLAUDE_OAUTH.refreshScope });
  return grantFrom(reply, (options.now ?? Date.now)(), refreshToken);
}

export type ClaudeOAuthState = {
  running: boolean;
  /** The URL the browser was sent to; shown so the user can open it by hand. */
  url: string | null;
  /** True when the code has to be pasted (no loopback listener). */
  manual: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
  /** Safe metadata for the account just added; no token or upstream UUID. */
  account: ClaudeAccountSummary | null;
};

/**
 * One sign-in attempt. `start()` returns the authorize URL; the grant arrives through the loopback
 * callback or `submitCode()`, whichever comes first; `result` resolves when the credential file is
 * written or the attempt failed. A session is single-use.
 */
export class ClaudeOAuthSession {
  readonly result: Promise<void>;
  private readonly options: ClaudeOAuthOptions;
  private readonly verifier = base64url(crypto.randomBytes(32));
  // 32 bytes, the size Claude Code 2.1.272 uses for both the verifier and the state.
  private readonly state = base64url(crypto.randomBytes(32));
  private redirectUri = "";
  private server: http.Server | null = null;
  private server6: http.Server | null = null;
  private settle!: { resolve: (grant: ClaudeOAuthGrant) => void; reject: (error: Error) => void };
  private readonly grant: Promise<ClaudeOAuthGrant>;
  private timer: NodeJS.Timeout | null = null;
  private exchanging = false;
  private finished = false;
  private stateSnapshot: ClaudeOAuthState = { running: false, url: null, manual: false, startedAt: null, finishedAt: null, ok: null, error: null, account: null };

  constructor(options: ClaudeOAuthOptions) {
    this.options = options;
    this.grant = new Promise<ClaudeOAuthGrant>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.result = this.grant.then(
      (grant) => {
        const account = saveClaudeOAuthAccount(options.home, grant);
        this.stateSnapshot = { ...this.stateSnapshot, running: false, finishedAt: new Date().toISOString(), ok: true, account };
      },
      (error: Error) => {
        this.stateSnapshot = { ...this.stateSnapshot, running: false, finishedAt: new Date().toISOString(), ok: false, error: error.message };
        throw error;
      },
    );
    // Nobody may be awaiting `result` (the GUI polls state instead); do not surface it as unhandled.
    this.result.catch(() => {});
  }

  get snapshot(): ClaudeOAuthState {
    return this.stateSnapshot;
  }

  /** The loopback port in use, once started. */
  port: number | null = null;

  /** Starts the loopback listener when possible and returns the URL to open. */
  async start(): Promise<{ url: string; manual: boolean }> {
    const manual = this.options.manual ? true : !(await this.listen(this.options.port ?? CLAUDE_OAUTH.port)) && !(await this.listen(0));
    this.redirectUri = manual ? CLAUDE_OAUTH.manualRedirectUri : `http://localhost:${this.port}${CLAUDE_OAUTH.callbackPath}`;
    const url = new URL(CLAUDE_OAUTH.authorizeUrl);
    url.search = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_OAUTH.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope: CLAUDE_OAUTH.scope,
      code_challenge: base64url(crypto.createHash("sha256").update(this.verifier).digest()),
      code_challenge_method: "S256",
      state: this.state,
    }).toString();
    this.timer = setTimeout(() => this.fail(new Error("Claude sign-in timed out; start it again")), CLAUDE_OAUTH.timeoutMs);
    this.timer.unref();
    this.stateSnapshot = { running: true, url: url.toString(), manual, startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null, account: null };
    return { url: url.toString(), manual };
  }

  /** Accepts `code`, `code#state`, or the full redirect URL the browser landed on. */
  async submitCode(input: string): Promise<void> {
    if (this.finished || this.exchanging) return;
    let code = input.trim();
    let state: string | null = null;
    try {
      const u = new URL(code);
      code = u.searchParams.get("code") ?? "";
      state = u.searchParams.get("state");
    } catch {
      const hash = code.indexOf("#");
      if (hash >= 0) {
        state = code.slice(hash + 1) || null;
        code = code.slice(0, hash);
      }
    }
    if (!code) {
      this.fail(new Error("No authorization code in what was pasted"));
      return;
    }
    if (state !== null && state !== this.state) {
      this.fail(new Error("The pasted code belongs to a different sign-in attempt"));
      return;
    }
    await this.exchange(code);
  }

  /** Abandons the attempt (a new one may start). */
  cancel(): void {
    this.fail(new Error("Claude sign-in cancelled"));
  }

  private listen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        const u = new URL(req.url ?? "/", "http://localhost");
        if (u.pathname !== CLAUDE_OAUTH.callbackPath) {
          res.writeHead(404).end();
          return;
        }
        const error = u.searchParams.get("error");
        const code = u.searchParams.get("code");
        // A request that is not for this attempt (wrong or missing state) is refused but does not
        // end the attempt: anything on the machine can hit a loopback port, and the real redirect
        // may still be on its way.
        if (u.searchParams.get("state") !== this.state || (!error && !code)) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Claude sign-in: this is not the sign-in ClaudeRipple is waiting for. You can close this tab.");
          return;
        }
        if (error || !code) {
          const detail = redactErrorText(error ?? "missing authorization code", [], 200);
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`Claude sign-in failed: ${detail}. You can close this tab.`);
          this.fail(new Error(`Claude refused the sign-in: ${detail}`));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ClaudeRipple: Claude subscription connected. You can close this tab.");
        void this.exchange(code);
      };
      const server = http.createServer(handler);
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        // The browser resolves "localhost" to ::1 or 127.0.0.1 as it likes; answer on both when
        // IPv6 loopback is available. Best effort: the IPv4 listener alone is enough on most systems.
        const six = http.createServer(handler);
        six.once("error", () => {});
        six.listen(this.port, "::1", () => {
          if (this.finished) {
            six.close();
            return;
          }
          this.server6 = six;
        });
        resolve(true);
      });
    });
  }

  private async exchange(code: string): Promise<void> {
    if (this.finished || this.exchanging) return;
    this.exchanging = true;
    try {
      const reply = await postToken(this.options.fetch ?? fetch, {
        grant_type: "authorization_code",
        client_id: CLAUDE_OAUTH.clientId,
        code,
        state: this.state,
        redirect_uri: this.redirectUri,
        code_verifier: this.verifier,
      });
      this.finish();
      this.settle.resolve(grantFrom(reply, (this.options.now ?? Date.now)()));
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private fail(error: Error): void {
    if (this.finished) return;
    this.finish();
    this.settle.reject(error);
  }

  private finish(): void {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    for (const server of [this.server, this.server6]) {
      if (!server) continue;
      server.close();
      // Keep-alive connections would otherwise hold the port for their idle timeout.
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    this.server = null;
    this.server6 = null;
  }
}

/** True when nothing is listening on the registered callback port (a hint for the GUI, not a guarantee). */
export function callbackPortFree(port = CLAUDE_OAUTH.port): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
