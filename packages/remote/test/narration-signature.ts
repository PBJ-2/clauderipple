// Test-only writer for the signature Claude Code puts on a thinking block: the CLI reads
// signature.field2 → field1 → field8 as the block's kind, so suites build the same bytes here
// instead of shipping a protobuf library.

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest ? low | 0x80 : low);
  } while (rest);
  return out;
}

/** One length-delimited (wire type 2) field. */
export function field(number: number, payload: Uint8Array | string): number[] {
  const bytes = typeof payload === "string" ? [...Buffer.from(payload, "utf8")] : [...payload];
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
}

/** A signature whose block kind is `kind`; `extra` fields ride in the same message and are skipped. */
export function signatureOf(kind: string, extra: Uint8Array = new Uint8Array()): string {
  const message = Uint8Array.from([...extra, ...field(8, kind)]);
  const envelope = Uint8Array.from(field(2, Uint8Array.from(field(1, message))));
  return Buffer.from(envelope).toString("base64");
}
