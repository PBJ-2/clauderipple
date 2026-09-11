// ChatGPT subscription credentials for the Codex backend.
//
// Two sources:
//   own          <home>/chatgpt-auth.json written by `clauderipple login` (OAuth PKCE). We refresh it.
//   borrow-codex ~/.codex/auth.json written by the Codex CLI. Read-only: refresh tokens rotate, and
//                refreshing someone else's grant would break their login. If it expires, the user runs
//                Codex once or logs in with us.
//
// OAuth constants are the public ones used by the Codex CLI (auth.openai.com, PKCE S256).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const OAUTH = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  port: 1455,
  scope: "openid profile email offline_access",
};

export type Tokens = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId: string;
  /** epoch ms */
  expiresAt: number;
  source: "own" | "borrow-codex";
};

export function ownAuthPath(home: string): string {
  return path.join(home, "chatgpt-auth.json");
}

export function codexAuthPath(): string {
  return process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : path.join(os.homedir(), ".codex", "auth.json");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function accountIdFromToken(token: string): string | null {
  const claims = decodeJwt(token);
  const auth = claims?.["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
  return auth?.chatgpt_account_id ?? null;
}

function expiryFromToken(token: string): number {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : 0;
}

export function readOwn(home: string): Tokens | null {
  try {
    const j = JSON.parse(fs.readFileSync(ownAuthPath(home), "utf8")) as Partial<Tokens>;
    if (!j.accessToken || !j.accountId) return null;
    return { ...(j as Tokens), source: "own" };
  } catch {
    return null;
  }
}

export function readBorrowed(): Tokens | null {
  try {
    const j = JSON.parse(fs.readFileSync(codexAuthPath(), "utf8")) as { tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string } };
    const t = j.tokens;
    if (!t?.access_token) return null;
    const accountId = t.account_id ?? accountIdFromToken(t.access_token);
    if (!accountId) return null;
    return {
      accessToken: t.access_token,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      ...(t.id_token ? { idToken: t.id_token } : {}),
      accountId,
      expiresAt: expiryFromToken(t.access_token),
      source: "borrow-codex",
    };
  } catch {
    return null;
  }
}

function writeOwn(home: string, t: Tokens): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownAuthPath(home), JSON.stringify(t, null, 2), { mode: 0o600 });
}

export async function refreshOwn(home: string, t: Tokens): Promise<Tokens> {
  if (!t.refreshToken) throw new Error("no refresh token; run `clauderipple login`");
  const res = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: OAUTH.clientId }),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
  const next: Tokens = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? t.refreshToken,
    ...(j.id_token ? { idToken: j.id_token } : {}),
    accountId: accountIdFromToken(j.access_token) ?? t.accountId,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : expiryFromToken(j.access_token),
    source: "own",
  };
  writeOwn(home, next);
  return next;
}

export class CredentialStore {
  private cached: Tokens | null = null;
  private readonly home: string;
  private readonly mode: "own" | "borrow-codex" | "auto";

  constructor(home: string, mode: "own" | "borrow-codex" | "auto" = "auto") {
    this.home = home;
    this.mode = mode;
  }

  /** Valid tokens or an Error describing what the user must do. Never throws. */
  async get(): Promise<Tokens | Error> {
    const skew = 5 * 60 * 1000;
    let t = this.cached;
    if (!t || Date.now() > t.expiresAt - skew) {
      t = this.mode === "borrow-codex" ? readBorrowed() : (readOwn(this.home) ?? (this.mode === "own" ? null : readBorrowed()));
      if (!t) return new Error("no ChatGPT credentials: run `clauderipple login`, or sign in to the Codex CLI once");
      if (Date.now() > t.expiresAt - skew) {
        if (t.source === "own") {
          try {
            t = await refreshOwn(this.home, t);
          } catch (e) {
            return new Error(`ChatGPT login expired and refresh failed (${(e as Error).message}); run \`clauderipple login\``);
          }
        } else {
          return new Error("borrowed Codex CLI login has expired; run `codex` once to refresh it, or `clauderipple login` for a login of our own");
        }
      }
      this.cached = t;
    }
    return t;
  }

  invalidate(): void {
    this.cached = null;
  }

  describe(): string {
    const own = readOwn(this.home);
    const bor = readBorrowed();
    const fmt = (t: Tokens | null): string => (t ? `${t.source} (expires ${new Date(t.expiresAt).toISOString().slice(0, 16)}Z)` : "none");
    return `own=${fmt(own)} borrow-codex=${fmt(bor)} mode=${this.mode}`;
  }
}

/** Interactive OAuth PKCE login. Opens the browser; the user signs in themselves. Resolves when tokens are stored. */
export async function login(home: string, openBrowser: (url: string) => void): Promise<Tokens> {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL(OAUTH.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    scope: OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      if (err || u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/plain" }).end(`Login failed: ${err ?? "state mismatch"}. You can close this tab.`);
        server.close();
        reject(new Error(err ?? "state mismatch"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end("<p>ClaudeRipple is signed in. You can close this tab.</p>");
      server.close();
      resolve(u.searchParams.get("code") ?? "");
    });
    server.on("error", reject);
    server.listen(OAUTH.port, "127.0.0.1", () => openBrowser(url.toString()));
    setTimeout(() => {
      server.close();
      reject(new Error("login timed out after 5 minutes"));
    }, 5 * 60 * 1000).unref();
  });

  const res = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: OAUTH.redirectUri, client_id: OAUTH.clientId, code_verifier: verifier }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number };
  const accountId = accountIdFromToken(j.access_token) ?? (j.id_token ? accountIdFromToken(j.id_token) : null);
  if (!accountId) throw new Error("token has no chatgpt_account_id claim");
  const t: Tokens = {
    accessToken: j.access_token,
    ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
    ...(j.id_token ? { idToken: j.id_token } : {}),
    accountId,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : expiryFromToken(j.access_token),
    source: "own",
  };
  writeOwn(home, t);
  return t;
}

export function logout(home: string): boolean {
  try {
    fs.unlinkSync(ownAuthPath(home));
    return true;
  } catch {
    return false;
  }
}
