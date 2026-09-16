// Anthropic native provider used by the OpenAI ingress.
// `claude-code` auth borrows Claude Code's credential read-only. It never refreshes, writes, or
// logs a token because refresh-token rotation would invalidate Claude Code's own credential.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnthropicProvider } from "../config.ts";
import { type ObservedClaudeCodeAuth, type ObservedClaudeCodeAuthSnapshot } from "./anthropic-observed.ts";
import { readClaudeAuthFile, saveClaudeOAuthFile } from "./anthropic-token-file.ts";
import { CLAUDE_OAUTH, refreshClaudeOAuth, type FetchLike } from "./claude-oauth.ts";

export const CLAUDE_CODE_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CACHE_MS = 60_000;

export type ClaudeCodeCredentials = { accessToken: string; expiresAt: number };
export type CredentialReader = () => string | null;
/** Source labels are deliberately metadata only: no token value reaches an admin response. */
export type ClaudeCodeAuthSource = "observed" | "env" | "keychain" | "credentials-file" | "token-file";
export type ClaudeCodeAuth =
  | { source: "observed"; observed: ObservedClaudeCodeAuthSnapshot }
  | { source: "env" | "token-file" | "stored"; credentials: ClaudeCodeCredentials };
export type ClaudeCodeAuthOptions = {
  observed?: ObservedClaudeCodeAuth;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam for the OAuth refresh. */
  fetch?: FetchLike;
  log?: (line: string) => void;
};

function claudeConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

export function readClaudeCodeKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

export function readClaudeCodeCredentialsFile(): string | null {
  try {
    return fs.readFileSync(path.join(claudeConfigDir(), ".credentials.json"), "utf8").trim();
  } catch {
    return null;
  }
}

/** Keychain first on macOS, then Claude Code's credential-file fallback. */
export function readClaudeCodeCredentials(): string | null {
  const keychain = readClaudeCodeKeychain();
  return parseClaudeCodeCredentials(keychain) ? keychain : readClaudeCodeCredentialsFile();
}

export function parseClaudeCodeCredentials(raw: string | null): ClaudeCodeCredentials | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const oauth = parsed.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || oauth.accessToken.length === 0 || typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    return null;
  }
}

export class ClaudeCodeCredentialStore {
  private cached: ClaudeCodeCredentials | null = null;
  private checkedAt = 0;
  private readonly read: CredentialReader;
  private readonly now: () => number;

  constructor(read: CredentialReader = readClaudeCodeCredentials, now: () => number = Date.now) {
    this.read = read;
    this.now = now;
  }

  /** Valid credential or a client-safe error. This deliberately never refreshes it. */
  get(): ClaudeCodeCredentials | Error {
    const now = this.now();
    if (!this.cached || now - this.checkedAt >= CACHE_MS) {
      this.cached = parseClaudeCodeCredentials(this.read());
      this.checkedAt = now;
    }
    if (!this.cached) return new Error("Claude Code login unavailable — open Claude Code and sign in");
    if (now >= this.cached.expiresAt) return new Error("Claude Code login expired — open Claude Code once to refresh");
    return this.cached;
  }
}

/**
 * Selects a Claude Code subscription credential without refreshing or mutating Claude Code's login.
 * A process-local observed header snapshot wins; all non-observed token sources use the normal OAuth wire shape.
 */
export class ClaudeCodeAuthStore {
  private readonly credentials: ClaudeCodeCredentialStore;
  private readonly observed: ObservedClaudeCodeAuth | undefined;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly log: (line: string) => void;
  private refreshing: Promise<void> | null = null;

  constructor(credentials = new ClaudeCodeCredentialStore(), options: ClaudeCodeAuthOptions = {}) {
    this.credentials = credentials;
    this.observed = options.observed;
    this.home = options.home ?? (process.env.CLAUDERIPPLE_HOME?.trim() || path.join(os.homedir(), ".clauderipple"));
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch;
    this.log = options.log ?? (() => {});
  }

  get(): ClaudeCodeAuth | Error {
    const observed = this.observed?.getFresh(this.now());
    if (observed) return { source: "observed", observed };
    const environment = this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (environment) return { source: "env", credentials: { accessToken: environment, expiresAt: Number.POSITIVE_INFINITY } };
    const stored = this.credentials.get();
    if (!(stored instanceof Error)) return { source: "stored", credentials: stored };
    const tokenFile = readClaudeAuthFile(this.home);
    if (tokenFile?.source === "setup-token") return { source: "token-file", credentials: { accessToken: tokenFile.token, expiresAt: Number.POSITIVE_INFINITY } };
    if (tokenFile?.source === "oauth") {
      if (this.now() >= tokenFile.expiresAt) return new Error("ClaudeRipple's Claude sign-in expired and could not be refreshed — connect the subscription again");
      return { source: "token-file", credentials: { accessToken: tokenFile.token, expiresAt: tokenFile.expiresAt } };
    }
    return stored;
  }

  /**
   * Refreshes our own OAuth grant when it is about to expire. Only ClaudeRipple's file is ever
   * written; Claude Code's credential is never refreshed (rotation would invalidate its copy).
   * Concurrent callers share one refresh. Failures are logged and leave the file as it was, so
   * get() reports the expiry once it arrives.
   */
  refreshIfNeeded(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    // Higher-precedence sources make the file irrelevant; do not touch the network for it.
    if (this.observed?.getFresh(this.now()) || this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || !(this.credentials.get() instanceof Error)) return Promise.resolve();
    const tokenFile = readClaudeAuthFile(this.home);
    if (tokenFile?.source !== "oauth" || this.now() < tokenFile.expiresAt - CLAUDE_OAUTH.refreshLeadMs) return Promise.resolve();
    this.refreshing = refreshClaudeOAuth(tokenFile.refreshToken, { ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}), now: this.now })
      .then(
        (grant) => {
          saveClaudeOAuthFile(this.home, grant, tokenFile.createdAt);
          this.log(`claude oauth: access token refreshed, valid until ${new Date(grant.expiresAt).toISOString()}`);
        },
        (error: Error) => {
          this.log(`claude oauth: refresh failed: ${error.message}`);
        },
      )
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /**
   * Returns only the currently usable credential source. This never returns a credential,
   * tests validity using the same precedence as get(), and does not refresh anything.
   */
  describeSource(): ClaudeCodeAuthSource | null {
    if (this.observed?.getFresh(this.now())) return "observed";
    if (this.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "env";
    const keychain = parseClaudeCodeCredentials(readClaudeCodeKeychain());
    if (keychain && this.now() < keychain.expiresAt) return "keychain";
    const credentialsFile = parseClaudeCodeCredentials(readClaudeCodeCredentialsFile());
    if (credentialsFile && this.now() < credentialsFile.expiresAt) return "credentials-file";
    return readClaudeAuthFile(this.home) ? "token-file" : null;
  }
}

/** Prefix custom tool names for subscription OAuth; builtin Anthropic tools stay unchanged. */
export function toClaudeCodeToolName(name: string): string {
  return /^(custom_|web_search$|code_execution$|text_editor$|computer$)/i.test(name) ? name : `custom_${name}`;
}

export function fromClaudeCodeToolName(name: string): string {
  return name.startsWith("custom_") ? name.slice("custom_".length) : name;
}

/**
 * Construct native Anthropic auth headers. OAuth wire requirements are behaviorally measured,
 * while API-key mode follows the public Messages API header convention.
 */
/** Reuses an observed CLI header set without adding manufactured fingerprint fields. */
export function observedAnthropicHeaders(observed: ObservedClaudeCodeAuthSnapshot): Record<string, string> {
  return { ...observed.headers };
}

export function nativeAnthropicHeaders(provider: AnthropicProvider, credentials?: ClaudeCodeCredentials): Record<string, string> {
  if (provider.auth === "api-key") {
    const apiKey = provider.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Anthropic API key missing — set providers.<name>.apiKey or ANTHROPIC_API_KEY");
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  if (!credentials) throw new Error("Claude Code login unavailable — open Claude Code and sign in");
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
    "user-agent": "claude-cli/2.1.266 (external, cli)",
    "x-app": "cli",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.74.0",
    "x-stainless-os": process.platform,
    "x-stainless-arch": process.arch,
    "x-claude-code-session-id": crypto.randomUUID(),
    "x-client-request-id": crypto.randomUUID(),
  };
}
