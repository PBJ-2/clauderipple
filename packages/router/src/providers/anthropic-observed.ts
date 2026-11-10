// Claude Code OAuth observed while transparently passing a real CLI request. Kept in RAM and,
// when a file path is given, mirrored to that file (mode 0600, owner's home) so the OpenAI ingress
// keeps working right after a router restart or a reboot — otherwise nothing works until the next
// Code-tab request happens to pass through. No diagnostics or listing surface exists.

import fs from "node:fs";
import { parseClaudeCliVersion } from "./claude-cli-version.ts";

export const OBSERVED_CLAUDE_CODE_TTL_MS = 12 * 60 * 60 * 1_000;

export type ObservedClaudeCodeAuthSnapshot = {
  /** Validated Bearer value. It is only used to make an upstream request. */
  authorization: string;
  /** Exact allowlisted CLI header values, including authorization. */
  headers: Readonly<Record<string, string>>;
  observedAt: number;
};

/** The token part of a validated Bearer value; tokens are compared without their scheme. */
function bearerToken(value: string): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1]! : null;
}

function isObservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization"
    || lower === "anthropic-beta"
    || lower === "anthropic-version"
    || lower === "user-agent"
    || lower === "x-app"
    || lower.startsWith("x-stainless-")
    || lower.startsWith("anthropic-client-");
}

/**
 * Stores the latest valid CLI Authorization plus its protocol-identifying headers in RAM.
 * Callers receive no inspection or listing API: getFresh() exists solely for direct forwarding.
 * noteUsed() and forget() exist only to keep the 12 h idle guard honest about a login that is
 * still being used; they read no token back.
 */
export class ObservedClaudeCodeAuth {
  private snapshot: ObservedClaudeCodeAuthSnapshot | null = null;
  /**
   * The token the upstream answered 401 for. An access token that was rejected does not become
   * valid again, so re-presenting it must not resurrect the login; a different token is a new
   * sign-in and is adopted normally.
   */
  private rejected: string | null = null;
  private readonly file: string | null;
  /** Last successfully saved freshness, independent of the timestamp moved by every use. */
  private persistedAt = Number.NEGATIVE_INFINITY;
  private cliVersionSeen: string | null = null;
  private cliVersionAt = 0;

  constructor(file?: string) {
    this.file = file ?? null;
    if (this.file) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as ObservedClaudeCodeAuthSnapshot;
        if (raw && typeof raw.authorization === "string" && raw.headers && typeof raw.observedAt === "number") {
          this.snapshot = { authorization: raw.authorization, headers: Object.freeze({ ...raw.headers }), observedAt: raw.observedAt };
          this.persistedAt = raw.observedAt;
          this.recordCliVersion(raw.headers, raw.observedAt);
        }
      } catch {
        /* no file yet or unreadable: start empty */
      }
    }
  }

  /** Keeps only the version token from `user-agent`, never the rest of the header set. */
  private recordCliVersion(headers: Readonly<Record<string, string>>, observedAt: number): void {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "user-agent") continue;
      const version = parseClaudeCliVersion(value);
      if (version) {
        this.cliVersionSeen = version;
        this.cliVersionAt = observedAt;
      }
      return;
    }
  }

  private persist(): void {
    if (!this.file || !this.snapshot) return;
    try {
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.persistedAt = this.snapshot.observedAt;
    } catch {
      /* best effort */
    }
  }

  observe(rawHeaders: readonly string[], observedAt = Date.now()): void {
    const headers: Record<string, string> = {};
    let authorization: string | null = null;
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      const name = rawHeaders[index]!;
      const value = rawHeaders[index + 1]!;
      if (!isObservedHeader(name)) continue;
      if (name.toLowerCase() === "authorization") {
        if (!/^Bearer\s+\S+$/i.test(value)) continue;
        authorization = value;
      }
      headers[name] = value;
    }
    if (!authorization) return;
    // A 401 already proved this token dead (see forget); the client may keep sending it until it
    // signs in again, which must not make the accounts list flap in and out per request.
    if (this.rejected !== null && bearerToken(authorization) === this.rejected) return;
    const changed = !this.snapshot || this.snapshot.authorization !== authorization || observedAt - this.persistedAt > 5 * 60_000;
    this.snapshot = {
      authorization,
      headers: Object.freeze({ ...headers }),
      observedAt,
    };
    // A different token is a sign-in or account switch; the previous token's refusal no longer applies.
    this.rejected = null;
    this.recordCliVersion(headers, observedAt);
    if (changed) this.persist();
  }

  /**
   * Counts the login being presented again — a routed request carried it, or the pool answered on
   * it — as still current. Only the login already held moves; a different token belongs to
   * observe(), which also replaces the header set (issue #123, 2026-11-05: 12 h of routed traffic
   * left the login forgotten because only an un-routed request used to refresh it).
   */
  noteUsed(authorization: string, at = Date.now()): void {
    const snapshot = this.snapshot;
    const token = bearerToken(authorization);
    if (!snapshot || !token || bearerToken(snapshot.authorization) !== token || at < snapshot.observedAt) return;
    const persistDue = at - this.persistedAt > 5 * 60_000;
    this.snapshot = { ...snapshot, observedAt: at };
    if (persistDue) this.persist();
  }

  /**
   * Drops the login after the upstream rejected this exact token with 401 (signed out or revoked).
   * A different token observed since then is left alone: the refusal belongs to that generation.
   */
  forget(authorization: string): void {
    const snapshot = this.snapshot;
    const token = bearerToken(authorization);
    if (!snapshot || !token || bearerToken(snapshot.authorization) !== token) return;
    this.rejected = token;
    this.snapshot = null;
    if (this.file) fs.rmSync(this.file, { force: true });
  }

  /**
   * The CLI version seen on the last observation that is still inside the snapshot's TTL, for the
   * fallback headers' `user-agent`. A bare version only: the header set itself is never exposed.
   */
  cliVersion(now = Date.now()): string | null {
    if (!this.cliVersionSeen || now < this.cliVersionAt || now - this.cliVersionAt >= OBSERVED_CLAUDE_CODE_TTL_MS) return null;
    return this.cliVersionSeen;
  }

  getFresh(now = Date.now()): ObservedClaudeCodeAuthSnapshot | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    if (now < snapshot.observedAt || now - snapshot.observedAt >= OBSERVED_CLAUDE_CODE_TTL_MS) {
      this.snapshot = null;
      if (this.file) fs.rmSync(this.file, { force: true });
      return null;
    }
    return snapshot;
  }
}
