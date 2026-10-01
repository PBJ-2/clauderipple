// thoughtSignature memory for the Google adapter (Gemini 3).
//
// Gemini 3 refuses a turn whose replayed functionCall part does not carry the `thoughtSignature`
// the model attached to that call: the request comes back 400 "Function call is missing a
// thought_signature in functionCall parts" (measured against Google's OpenAI-compatible endpoint,
// microsoft/vscode#296713, 2026-10). Claude Code's history carries tool_use blocks, not Gemini
// parts, so the signature has nowhere to live except here: the adapter stores it when the answer
// arrives and puts it back on the matching functionCall when the same call is replayed.
//
// Keyed by the tool_use id we minted. That is stable for one tool call within a conversation, and
// two conversations never share an id (the ids are random), so the store needs no further scoping.
//
// Bounded LRU: thought signatures are large opaque strings, and an unbounded map would grow for the
// life of the process.

/** Upper bound on remembered signatures. Far more than a conversation holds; small enough to forget. */
const DEFAULT_LIMIT = 10_000;

export class ThoughtSignatureStore {
  // Insertion order is the LRU order: a get re-inserts, a set past the limit drops the oldest.
  private readonly map = new Map<string, string>();
  private readonly limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  get(id: string): string | undefined {
    const value = this.map.get(id);
    if (value === undefined) return undefined;
    // Refresh recency so a signature that keeps being replayed is not evicted under a busy store.
    this.map.delete(id);
    this.map.set(id, value);
    return value;
  }

  set(id: string, signature: string): void {
    if (!id || !signature) return;
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, signature);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number { return this.map.size; }
}
