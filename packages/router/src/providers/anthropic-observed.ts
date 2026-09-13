// Claude Code OAuth observed while transparently passing a real CLI request. Kept in RAM and,
// when a file path is given, mirrored to that file (mode 0600, owner's home) so the OpenAI ingress
// keeps working right after a router restart or a reboot — otherwise nothing works until the next
// Code-tab request happens to pass through. No diagnostics or listing surface exists.

import fs from "node:fs";

export const OBSERVED_CLAUDE_CODE_TTL_MS = 12 * 60 * 60 * 1_000;

export type ObservedClaudeCodeAuthSnapshot = {
  /** Validated Bearer value. It is only used to make an upstream request. */
  authorization: string;
  /** Exact allowlisted CLI header values, including authorization. */
  headers: Readonly<Record<string, string>>;
  observedAt: number;
};

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
 */
export class ObservedClaudeCodeAuth {
  private snapshot: ObservedClaudeCodeAuthSnapshot | null = null;
  private readonly file: string | null;

  constructor(file?: string) {
    this.file = file ?? null;
    if (this.file) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as ObservedClaudeCodeAuthSnapshot;
        if (raw && typeof raw.authorization === "string" && raw.headers && typeof raw.observedAt === "number") {
          this.snapshot = { authorization: raw.authorization, headers: Object.freeze({ ...raw.headers }), observedAt: raw.observedAt };
        }
      } catch {
        /* no file yet or unreadable: start empty */
      }
    }
  }

  private persist(): void {
    if (!this.file || !this.snapshot) return;
    try {
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
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
    const changed = !this.snapshot || this.snapshot.authorization !== authorization || observedAt - this.snapshot.observedAt > 5 * 60_000;
    this.snapshot = {
      authorization,
      headers: Object.freeze({ ...headers }),
      observedAt,
    };
    if (changed) this.persist();
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
