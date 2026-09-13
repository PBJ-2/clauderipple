// ClaudeRipple-owned storage for a `claude setup-token` OAuth token.
// This is intentionally separate from Claude Code's own credential stores.

import fs from "node:fs";
import path from "node:path";

export type ClaudeAuthFile = {
  token: string;
  createdAt: string;
  source: "setup-token";
};

export function claudeAuthPath(home: string): string {
  return path.join(home, "claude-auth.json");
}

export function readClaudeAuthFile(home: string): ClaudeAuthFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(claudeAuthPath(home), "utf8")) as Partial<ClaudeAuthFile>;
    if (typeof raw.token !== "string" || raw.token.length === 0 || typeof raw.createdAt !== "string" || raw.source !== "setup-token") return null;
    return { token: raw.token, createdAt: raw.createdAt, source: "setup-token" };
  } catch {
    return null;
  }
}

export function saveClaudeAuthFile(home: string, token: string, createdAt = new Date().toISOString()): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = claudeAuthPath(home);
  fs.writeFileSync(file, JSON.stringify({ token, createdAt, source: "setup-token" }) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
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
