// Thinking blocks another model left in a conversation that is now going to Anthropic.
//
// The translated providers hand the CLI their reasoning as `thinking` blocks with no signature —
// there is no Anthropic signature to give — and an empty `thinking` when the upstream sent a
// reasoning item without a summary. The CLI keeps them in the transcript, so a session switched
// from such a model to a Claude model replays them, and Anthropic refuses the whole request:
// "messages.2.content.0.thinking: each thinking block must contain thinking" (measured 2026-09-28,
// gpt-6-astra → claude-opus-5-5, every retry of the turn). A block Anthropic wrote always carries a
// signature, so an unsigned one is foreign and goes; the translated providers drop thinking from
// replayed history for the same reason (ARCHITECTURE §4, "Cache-safety decisions").

type Block = { type?: unknown; signature?: unknown };
type Message = { role?: unknown; content?: unknown };

function foreign(block: unknown): boolean {
  const b = block as Block | null;
  return !!b && typeof b === "object" && b.type === "thinking" && !(typeof b.signature === "string" && b.signature.length > 0);
}

/**
 * Removes unsigned thinking blocks from assistant turns, in place, and returns how many went.
 * A turn left with no content is removed with them: Anthropic refuses an empty assistant turn,
 * and joins the two user turns that then meet.
 */
export function dropForeignThinking(json: Record<string, unknown>): number {
  const messages = json.messages;
  if (!Array.isArray(messages)) return 0;
  let removed = 0;
  const kept: unknown[] = [];
  for (const message of messages as Message[]) {
    if (message?.role !== "assistant" || !Array.isArray(message.content) || !message.content.some(foreign)) {
      kept.push(message);
      continue;
    }
    const content = message.content.filter((block) => !foreign(block));
    removed += message.content.length - content.length;
    if (content.length > 0) kept.push({ ...message, content });
  }
  if (removed > 0) json.messages = kept;
  return removed;
}
