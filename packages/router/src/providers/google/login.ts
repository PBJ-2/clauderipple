// Google Antigravity (Cloud Code Assist) sign-in: the OAuth authorization-code flow with PKCE, the
// project discovery that follows it, and the account it leaves in the store.
//
// The loopback listener is preferred on port 51121 (the Antigravity desktop client's), falling back
// to any free port — Google's installed-app clients accept an arbitrary loopback port, and the
// redirect_uri in the token exchange is the one actually bound. state and PKCE verifier are per
// attempt; a callback with the wrong state is refused without ending the attempt; an attempt expires
// after 5 minutes.
//
// Wire facts (authorize params, token body, the userinfo call, project discovery) are taken from the
// reference implementation opencodex as a behavioral spec (src/oauth/google-antigravity.ts) and are
// **not measured live** — see docs/ARCHITECTURE.md §4d.

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { redactErrorText } from "../../redact.ts";
import { saveGoogleAccount, type GoogleAccountSummary } from "./accounts.ts";
import { discoverProject, fetchUserEmail, GOOGLE_OAUTH, type FetchLike } from "./antigravity.ts";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type GoogleOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  projectId: string;
  email?: string;
  /** epoch ms */
  expiresAt: number;
};

export type GoogleOAuthOptions = {
  home: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Test seam: listen on this port instead of 51121. The redirect_uri keeps the port actually bound. */
  port?: number;
};

/**
 * Exchange an authorization code for a grant. The token endpoint is Google's, form-encoded, with the
 * public client id and secret. Exported so the refresh path and tests can reuse it without a browser.
 */
export async function exchangeGoogleCode(
  opts: { code: string; codeVerifier: string; redirectUri: string; fetch?: FetchLike; now?: () => number },
): Promise<GoogleOAuthGrant> {
  const res = await (opts.fetch ?? fetch)(GOOGLE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: GOOGLE_OAUTH.clientId,
      client_secret: GOOGLE_OAUTH.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(GOOGLE_OAUTH.requestTimeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Google sign-in was refused by the token endpoint: HTTP ${res.status} ${redactErrorText(text, [opts.code], 300)}`);
  let j: { access_token?: string; refresh_token?: string; expires_in?: number };
  try { j = JSON.parse(text) as typeof j; } catch { throw new Error("Google sign-in answered with something other than JSON"); }
  if (typeof j.access_token !== "string" || j.access_token.length === 0) throw new Error("Google sign-in returned no access token");
  if (typeof j.refresh_token !== "string" || j.refresh_token.length === 0) {
    // Without a refresh token every request would work until this one expires and then fail closed.
    throw new Error("Google sign-in returned no refresh token (re-consent with access_type=offline and prompt=consent)");
  }
  const expiresIn = typeof j.expires_in === "number" && Number.isFinite(j.expires_in) && j.expires_in > 0 ? j.expires_in : 3600;
  const now = (opts.now ?? Date.now)();
  const [email, projectId] = await Promise.all([
    fetchUserEmail(j.access_token, opts.fetch ?? fetch),
    discoverProject(j.access_token, opts.fetch ?? fetch),
  ]);
  if (!projectId) {
    // A credential with no Cloud Code Assist project would answer every request with an error while
    // the dashboard reads "signed in". Fail the sign-in instead.
    throw new Error("could not discover a Cloud Code Assist project for this account; make sure it has Antigravity/Cloud Code Assist access and try again");
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    projectId,
    ...(email ? { email } : {}),
    expiresAt: now + expiresIn * 1000,
  };
}

export type GoogleOAuthState = {
  running: boolean;
  /** The URL the browser was sent to; shown so the user can open it by hand. */
  url: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
  /** Safe metadata for the account just added; no token. */
  account: GoogleAccountSummary | null;
  /**
   * The terms warning, for a client to show before a sign-in starts. Not named `warning`: the GUI
   * toasts any `warning` an admin response carries as an error, and the sign-in is polled every 2s.
   */
  termsWarning: string;
};

/**
 * One sign-in attempt. `start()` returns the authorize URL; the grant arrives through the loopback
 * callback or `submitCode()`, whichever comes first; `result` resolves when the credential file is
 * written or the attempt failed. A session is single-use.
 */
export class GoogleOAuthSession {
  readonly result: Promise<void>;
  private readonly options: GoogleOAuthOptions;
  private readonly verifier = base64url(crypto.randomBytes(32));
  private readonly state = crypto.randomBytes(16).toString("hex");
  private redirectUri = "";
  private server: http.Server | null = null;
  private server6: http.Server | null = null;
  private settle!: { resolve: (grant: GoogleOAuthGrant) => void; reject: (error: Error) => void };
  private readonly grant: Promise<GoogleOAuthGrant>;
  private timer: NodeJS.Timeout | null = null;
  private exchanging = false;
  private finished = false;
  private stateSnapshot: GoogleOAuthState;

  constructor(options: GoogleOAuthOptions, warning: string) {
    this.options = options;
    this.stateSnapshot = { running: false, url: null, startedAt: null, finishedAt: null, ok: null, error: null, account: null, termsWarning: warning };
    this.grant = new Promise<GoogleOAuthGrant>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.result = this.grant.then(
      (grant) => {
        const account = saveGoogleAccount(options.home, grant);
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

  get snapshot(): GoogleOAuthState {
    return this.stateSnapshot;
  }

  /** The loopback port in use, once started. */
  port: number | null = null;

  /** Starts the loopback listener and returns the URL to open. */
  async start(): Promise<{ url: string; port: number }> {
    if (!(await this.listen(this.options.port ?? GOOGLE_OAUTH.port)) && !(await this.listen(0))) {
      throw new Error(`could not open a loopback callback port (tried ${this.options.port ?? GOOGLE_OAUTH.port}); close whatever is using it and try again`);
    }
    this.redirectUri = `http://127.0.0.1:${this.port}${GOOGLE_OAUTH.callbackPath}`;
    const url = new URL(GOOGLE_OAUTH.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: GOOGLE_OAUTH.clientId,
      redirect_uri: this.redirectUri,
      scope: GOOGLE_OAUTH.scopes.join(" "),
      code_challenge: base64url(crypto.createHash("sha256").update(this.verifier).digest()),
      code_challenge_method: "S256",
      access_type: "offline",
      // select_account lets the user pick a different Google account when adding a second one.
      prompt: "consent select_account",
      state: this.state,
    }).toString();
    this.timer = setTimeout(() => this.fail(new Error("Google sign-in timed out; start it again")), GOOGLE_OAUTH.timeoutMs);
    this.timer.unref();
    this.stateSnapshot = { ...this.stateSnapshot, running: true, url: url.toString(), startedAt: new Date().toISOString(), finishedAt: null, ok: null, error: null, account: null };
    return { url: url.toString(), port: this.port! };
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
      this.fail(new Error("no authorization code in what was pasted"));
      return;
    }
    if (state !== null && state !== this.state) {
      this.fail(new Error("the pasted code belongs to a different sign-in attempt"));
      return;
    }
    await this.exchange(code);
  }

  /** Abandons the attempt (a new one may start). */
  cancel(): void {
    this.fail(new Error("Google sign-in cancelled"));
  }

  private listen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        const u = new URL(req.url ?? "/", "http://localhost");
        if (u.pathname !== GOOGLE_OAUTH.callbackPath) {
          res.writeHead(404).end();
          return;
        }
        const error = u.searchParams.get("error");
        const code = u.searchParams.get("code");
        // A request that is not for this attempt (wrong or missing state) is refused but does not end
        // the attempt: anything on the machine can hit a loopback port, and the real redirect may
        // still be on its way.
        if (u.searchParams.get("state") !== this.state || (!error && !code)) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Google sign-in: this is not the sign-in ClaudeRipple is waiting for. You can close this tab.");
          return;
        }
        if (error || !code) {
          const detail = redactErrorText(error ?? "missing authorization code", [], 200);
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`Google sign-in failed: ${detail}. You can close this tab.`);
          this.fail(new Error(`Google refused the sign-in: ${detail}`));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ClaudeRipple: Google account connected. You can close this tab.");
        void this.exchange(code);
      };
      const server = http.createServer(handler);
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        // The browser resolves "localhost" to ::1 or 127.0.0.1 as it likes; answer on both when IPv6
        // loopback is available. Best effort.
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
      const grant = await exchangeGoogleCode({ code, codeVerifier: this.verifier, redirectUri: this.redirectUri, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(this.options.now ? { now: this.options.now } : {}) });
      this.finish();
      this.settle.resolve(grant);
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
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    this.server = null;
    this.server6 = null;
  }
}
