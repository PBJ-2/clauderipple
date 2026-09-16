// ClaudeRipple-owned storage for a Claude subscription credential of our own: either a long-lived
// `claude setup-token` token or an OAuth grant obtained by `clauderipple claude-login` (browser
// flow, PKCE). This is intentionally separate from Claude Code's own credential stores, which are
// only ever read.

import fs from "node:fs";
import path from "node:path";

export type ClaudeAuthFile =
  | { token: string; createdAt: string; source: "setup-token" }
  | {
      token: string;
      createdAt: string;
      source: "oauth";
      refreshToken: string;
      /** epoch ms; the access token is refreshed shortly before this. */
      expiresAt: number;
    };

export function claudeAuthPath(home: string): string {
  return path.join(home, "claude-auth.json");
}

export function readClaudeAuthFile(home: string): ClaudeAuthFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(claudeAuthPath(home), "utf8")) as Partial<ClaudeAuthFile> & { refreshToken?: unknown; expiresAt?: unknown };
    if (typeof raw.token !== "string" || raw.token.length === 0 || typeof raw.createdAt !== "string") return null;
    if (raw.source === "setup-token") return { token: raw.token, createdAt: raw.createdAt, source: "setup-token" };
    if (raw.source === "oauth" && typeof raw.refreshToken === "string" && raw.refreshToken.length > 0 && typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt)) {
      return { token: raw.token, createdAt: raw.createdAt, source: "oauth", refreshToken: raw.refreshToken, expiresAt: raw.expiresAt };
    }
    return null;
  } catch {
    return null;
  }
}

function writeClaudeAuthFile(home: string, value: ClaudeAuthFile): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = claudeAuthPath(home);
  fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function saveClaudeAuthFile(home: string, token: string, createdAt = new Date().toISOString()): void {
  writeClaudeAuthFile(home, { token, createdAt, source: "setup-token" });
}

export function saveClaudeOAuthFile(home: string, grant: { accessToken: string; refreshToken: string; expiresAt: number }, createdAt = new Date().toISOString()): void {
  writeClaudeAuthFile(home, { token: grant.accessToken, createdAt, source: "oauth", refreshToken: grant.refreshToken, expiresAt: grant.expiresAt });
}

export function removeClaudeAuthFile(home: string): boolean {
  try {
    fs.unlinkSync(claudeAuthPath(home));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
