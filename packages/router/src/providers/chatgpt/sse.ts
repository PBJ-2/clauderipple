// Minimal SSE parser: bytes in, `data:` payloads out. Handles multi-line data and CRLF.

export class SseParser {
  private buf = "";
  /** The stream's own end marker arrived — a vendor that ends on `[DONE]` finished on purpose. */
  sawDone = false;

  /** Feed a chunk; returns the parsed JSON objects of complete events (non-JSON data is skipped). */
  feed(chunk: string): Record<string, unknown>[] {
    this.buf += chunk;
    const out: Record<string, unknown>[] = [];
    let idx: number;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "[DONE]") this.sawDone = true;
      if (!data || data === "[DONE]") continue;
      try {
        out.push(JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* ignore non-JSON frames */
      }
    }
    return out;
  }
}
