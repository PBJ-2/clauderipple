// Process-local Claude Code OAuth observed while transparently passing a real CLI request.
// This holder deliberately has no serialization, diagnostics, or persistence surface.

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
    this.snapshot = {
      authorization,
      headers: Object.freeze({ ...headers }),
      observedAt,
    };
  }

  getFresh(now = Date.now()): ObservedClaudeCodeAuthSnapshot | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    if (now < snapshot.observedAt || now - snapshot.observedAt >= OBSERVED_CLAUDE_CODE_TTL_MS) {
      this.snapshot = null;
      return null;
    }
    return snapshot;
  }
}
