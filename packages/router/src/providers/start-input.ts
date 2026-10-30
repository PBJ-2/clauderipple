// The input figure a translated adapter announces in message_start.
//
// Claude Code snapshots `message.usage` per streamed content block, before message_delta brings the
// real figures, so message_start has to carry an estimate (chatgpt/translate.ts `start`). While a
// response streams, that estimate is what /context reconciles its Messages row to, and what the
// session's context share reads. A character count over four is no tokenizer: on 2026-10-30 a
// GPT-6.1 Sol chat measured 281k input while its request estimated 648k, so every streaming
// response showed the context at 136% of a 475k window, and the real figure came back as each one
// finished.
//
// So once a conversation has been measured, the figure is that measurement plus only the estimated
// growth since. The estimate's error is then confined to the few messages added in between. A
// request smaller than the measured one is a conversation rewritten (compacted, cleared, forked): the
// measurement no longer describes it and the plain estimate stands.

const KEEP = 500;

export class StartInputs {
  /** The last measured input per conversation, with the estimate of the request it measured. */
  private readonly measured = new Map<string, { tokens: number; estimate: number }>();
  /** The estimate of the request last started per conversation, which the next measurement belongs to. */
  private readonly asked = new Map<string, number>();

  /** The figure for this request's message_start, given its own estimate. */
  start(key: string, estimate: number): number {
    remember(this.asked, key, estimate);
    const last = this.measured.get(key);
    return last && estimate >= last.estimate ? last.tokens + estimate - last.estimate : estimate;
  }

  /**
   * The real input (uncached plus cached) the provider reported for the conversation's request. Two
   * requests in flight on one conversation pair the measurement with the later one's estimate; the
   * figure is an estimate either way, and the next measurement corrects it.
   */
  note(key: string, usage: { input_tokens: number; cache_read_input_tokens: number }): void {
    const tokens = usage.input_tokens + usage.cache_read_input_tokens;
    const estimate = this.asked.get(key);
    if (tokens <= 0 || estimate === undefined) return;
    remember(this.measured, key, { tokens, estimate });
  }
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > KEEP) map.delete(map.keys().next().value!);
}
