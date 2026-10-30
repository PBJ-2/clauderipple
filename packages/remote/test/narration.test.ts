import test from "node:test";
import assert from "node:assert/strict";
import { narrationBody, signatureBlockKind } from "../src/narration.ts";
import { field, signatureOf } from "./narration-signature.ts";

const block = (signature: unknown, thinking: unknown = "Looking at the diff") => ({ type: "thinking", thinking, signature });

test("a signature marked narration turns its block into a visible sentence", () => {
  assert.equal(signatureBlockKind(signatureOf("narration")), "narration");
  assert.deepEqual(narrationBody(block(signatureOf("narration")), "m1", 3), { kind: "narration", msg: "m1", block: 3, text: "Looking at the diff" });
  // The sentence keeps its own spacing; only emptiness decides.
  assert.equal(narrationBody(block(signatureOf("narration"), "  Next, the tests.  "), "m1", 3)?.text, "  Next, the tests.  ");
});

test("the last field 2 decides, and other wire types are skipped", () => {
  const earlier = Uint8Array.from(field(2, Uint8Array.from(field(1, Uint8Array.from(field(8, "thinking"))))));
  const later = Uint8Array.from(field(2, Uint8Array.from(field(1, Uint8Array.from(field(8, "narration"))))));
  assert.equal(signatureBlockKind(Buffer.from(Uint8Array.from([...earlier, ...later])).toString("base64")), "narration");
  // varint (0x08), fixed64 (0x11), length-delimited (0x1a) and fixed32 (0x25) ride along.
  const skipped = Uint8Array.from([0x08, 0x96, 0x01, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x1a, 0x02, 0x68, 0x69, 0x25, 9, 10, 11, 12]);
  assert.equal(signatureBlockKind(signatureOf("narration", skipped)), "narration");
});

test("empty words, another kind or another block type stays thinking", () => {
  assert.equal(narrationBody(block(signatureOf("narration"), "   "), "m", 0), null);
  assert.equal(narrationBody(block(signatureOf("narration"), 7), "m", 0), null);
  assert.equal(narrationBody(block(signatureOf("thinking")), "m", 0), null);
  assert.equal(narrationBody(block(signatureOf("summary")), "m", 0), null);
  assert.equal(narrationBody({ type: "text", thinking: "Words", signature: signatureOf("narration") }, "m", 0), null);
  assert.equal(narrationBody(null, "m", 0), null);
  assert.equal(narrationBody("thinking", "m", 0), null);
});

test("an unreadable signature fails closed", () => {
  const valid = signatureOf("narration");
  const urlSafe = Buffer.from(Buffer.from(valid, "base64")).toString("base64url");
  if (urlSafe !== valid) assert.equal(signatureBlockKind(urlSafe), null, "base64url is not the standard alphabet");
  assert.equal(signatureBlockKind("ab-_"), null, "outside the alphabet");
  assert.equal(signatureBlockKind(Buffer.from([0xff, 0xff, 0xff]).toString("base64")), null, "a varint that runs off the end");
  assert.equal(signatureBlockKind(Buffer.from([0x1a, 0x7f, 0xff, 0x00, 0xc3, 0x28]).toString("base64")), null, "a length past the end");
  const bytes = Buffer.from(valid, "base64");
  assert.equal(signatureBlockKind(bytes.subarray(0, bytes.length - 3).toString("base64")), null, "a cut-off message");
  assert.equal(signatureBlockKind(valid + "="), null, "a length that is not a multiple of four");
  assert.equal(signatureBlockKind(""), null);
  for (const value of [undefined, null, 0, true, {}, []]) assert.equal(signatureBlockKind(value), null);
  assert.equal(narrationBody(block(42), "m", 0), null);
});
