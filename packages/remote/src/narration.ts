// A thinking block's signature says what the block is. Claude Code marks the progress sentence it
// writes before or between tool calls as "narration"; everything else stays hidden thinking. The CLI
// and the desktop app both read that marker, so the phone shows the same sentences (issue #118).
import type { EventBody } from "./protocol.ts";

export type Narration = Extract<EventBody, { kind: "narration" }>;

const BASE64 = /^[A-Za-z0-9+/=]+$/;

/** A varint at `from`; throws on a truncated or over-long one. */
function varint(bytes: Uint8Array, from: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  let i = from;
  for (;;) {
    if (i >= bytes.length) throw new Error("truncated varint");
    const byte = bytes[i++]!;
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return { value, next: i };
    scale *= 128;
    if (scale > 2 ** 63) throw new Error("varint too long");
  }
}

/** The last length-delimited field `number` of a protobuf message; every other wire type is skipped. */
function lastField(bytes: Uint8Array, number: number): Uint8Array | null {
  let found: Uint8Array | null = null;
  let i = 0;
  while (i < bytes.length) {
    const key = varint(bytes, i);
    i = key.next;
    const wire = key.value & 7;
    const field = Math.floor(key.value / 8);
    if (wire === 0) { i = varint(bytes, i).next; continue; }
    if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > bytes.length) throw new Error("truncated fixed field");
      i += size;
      continue;
    }
    if (wire !== 2) throw new Error("unsupported wire type");
    const length = varint(bytes, i);
    const end = length.next + length.value;
    if (end > bytes.length) throw new Error("truncated length-delimited field");
    if (field === number) found = bytes.subarray(length.next, end);
    i = end;
  }
  return found;
}

/** The kind a thinking block's signature carries ("narration", "thinking", …), or null when it cannot be read. */
export function signatureBlockKind(signature: unknown): string | null {
  try {
    if (typeof signature !== "string" || !BASE64.test(signature) || signature.length % 4 !== 0) return null;
    const envelope = lastField(Buffer.from(signature, "base64"), 2);
    const message = envelope && lastField(envelope, 1);
    const kind = message && lastField(message, 8);
    return kind ? Buffer.from(kind).toString("utf8") : null;
  } catch {
    return null;
  }
}

/** The visible sentence a block holds, or null for anything that stays thinking (including an unreadable signature). */
export function narrationBody(block: unknown, msg: string, index: number): Narration | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { type?: unknown; thinking?: unknown; signature?: unknown };
  if (b.type !== "thinking" || typeof b.thinking !== "string" || !b.thinking.trim()) return null;
  if (signatureBlockKind(b.signature) !== "narration") return null;
  return { kind: "narration", msg, block: index, text: b.thinking };
}
