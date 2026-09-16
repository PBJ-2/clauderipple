// Claude subscription sign-in of our own: the OAuth authorization-code flow with PKCE that Claude
// Code itself uses, driven from ClaudeRipple so that no terminal is needed. Until 0.1.2 the only
// way to connect a subscription was `claude setup-token`, an interactive terminal flow that the
// tray app and the GUI cannot host (2026-09-15, Windows report).
//
// Wire facts are behaviorally measured against Claude Code's public client and are not an
// Anthropic guarantee (docs/ARCHITECTURE.md §4b). The browser is sent to claude.ai; the code comes
// back either to a loopback listener on the registered port or, when that port is taken, through
// the manual "paste the code" page (`code#state`). Tokens are stored only in <home>/claude-auth.json
// (mode 0600) and never logged or returned by the admin API.

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { saveClaudeOAuthFile } from "./anthropic-token-file.ts";

export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  scope: "org:create_api_key user:profile user:inference",
  port: 54545,
  callbackPath: "/callback",
  /** Anthropic's own page that shows the code for pasting when no loopback listener can be reached. */
  manualRedirectUri: "https://console.anthropic.com/oauth/code/callback",
  /** How long a sign-in may stay open before it is abandoned. */
  timeoutMs: 5 * 60 * 1000,
  /** Refresh this long before the access token expires. */
  refreshLeadMs: 5 * 60 * 1000,
} as const;

export type ClaudeOAuthGrant = { accessToken: string; refreshToken: string; expiresAt: number };
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
type TokenReply = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };

async function postToken(fetchImpl: FetchLike, body: Record<string, string>): Promise<TokenReply> {
  const response = await fetchImpl(CLAUDE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: TokenReply = {};
  try {
    parsed = JSON.parse(text) as TokenReply;
  } catch {
    // A non-JSON body is reported through the status below.
  }
  if (!response.ok) {
    const detail = typeof parsed.error_description === "string" ? parsed.error_description : typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
    throw new Error(`Claude sign-in was refused by the token endpoint: ${detail}`);
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
  return { accessToken: reply.access_token, refreshToken, expiresAt: now + expiresIn * 1000 };
}

/** Exchanges a refresh token; the caller persists the result. */
export async function refreshClaudeOAuth(refreshToken: string, options: { fetch?: FetchLike; now?: () => number } = {}): Promise<ClaudeOAuthGrant> {
  const reply = await postToken(options.fetch ?? fetch, { grant_type: "refresh_token", client_id: CLAUDE_OAUTH.clientId, refresh_token: refreshToken });
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
  private readonly state = base64url(crypto.randomBytes(16));
  private redirectUri = "";
  private server: http.Server | null = null;
  private settle!: { resolve: (grant: ClaudeOAuthGrant) => void; reject: (error: Error) => void };
  private readonly grant: Promise<ClaudeOAuthGrant>;
  private timer: NodeJS.Timeout | null = null;
  private finished = false;
  private stateSnapshot: ClaudeOAuthState = { running: false, url: null, manual: false, startedAt: null, finishedAt: null, ok: null, error: null };

  constructor(options: ClaudeOAuthOptions) {
    this.options = options;
    this.grant = new Promise<ClaudeOAuthGrant>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.result = this.grant.then(
      (grant) => {
        saveClaudeOAuthFile(options.home, grant);
        this.stateSnapshot = { ...this.stateSnapshot, running: false, finishedAt: new Date().toISOString(), ok: true };
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

  /** Starts the loopback listener when possible and returns the URL to open. */
  async start(): Promise<{ url: string; manual: boolean }> {
    const manual = this.options.manual ? true : !(await this.listen());
    this.redirectUri = manual ? CLAUDE_OAUTH.manualRedirectUri : `http://localhost:${CLAUDE_OAUTH.port}${CLAUDE_OAUTH.callbackPath}`;
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
    this.stateSnapshot = { running: true, url: url.toString(), manual, startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null };
    return { url: url.toString(), manual };
  }

  /** Accepts `code`, `code#state`, or the full redirect URL the browser landed on. */
  async submitCode(input: string): Promise<void> {
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

  private listen(): Promise<boolean> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
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
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`Claude sign-in failed: ${error}. You can close this tab.`);
          this.fail(new Error(`Claude refused the sign-in: ${error}`));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ClaudeRipple: Claude subscription connected. You can close this tab.");
        void this.exchange(code);
      });
      server.once("error", () => resolve(false));
      server.listen(this.options.port ?? CLAUDE_OAUTH.port, "127.0.0.1", () => {
        this.server = server;
        resolve(true);
      });
    });
  }

  private async exchange(code: string): Promise<void> {
    if (this.finished) return;
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
    const server = this.server;
    this.server = null;
    if (server) {
      server.close();
      // Keep-alive connections would otherwise hold the port for their idle timeout.
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
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
