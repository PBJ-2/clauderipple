import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { modPhotoText, photoLine, readModPhotoText, writeModPhotos } from "../src/mod-photos.ts";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]).toString("base64");
const JPEG = Buffer.from([255, 216, 255, 224, 1, 2, 3]).toString("base64");

function root(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mod-photos-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "mod-photos");
}

test("photos are written under session/item-n.ext with the extension of what the bytes are", t => {
  const dir = root(t);
  const files = writeModPhotos(dir, "sess-1", "item-1", [PNG, JPEG]);
  assert.deepEqual(files.map(file => path.relative(dir, file)), [path.join("sess-1", "item-1-1.png"), path.join("sess-1", "item-1-2.jpg")]);
  assert.equal(writeModPhotos(dir, "sess-1", "item-1", [PNG, JPEG]).join(), files.join(), "a retry names the same files");
  assert.equal(fs.readdirSync(path.join(dir, "sess-1")).length, 2, "and leaves no copy or temp file");
});

test("bytes that are no image, or over the cap, write nothing", t => {
  const dir = root(t);
  assert.throws(() => writeModPhotos(dir, "s", "i", [PNG, Buffer.from("text").toString("base64")]));
  assert.equal(fs.existsSync(dir), false);
});

test("the text is the person's words, a blank line, then one line per photo; the person's text comes back out of it", t => {
  const dir = root(t);
  const files = writeModPhotos(dir, "s", "i", [PNG, JPEG]);
  const text = modPhotoText("Look at these\nplease", files);
  assert.equal(text, `Look at these\nplease\n\n${photoLine(files[0]!)}\n${photoLine(files[1]!)}`);
  assert.match(photoLine("/x/y.png"), /^\[Attached photo: \/x\/y\.png — open it with the Read tool to see it\]$/);
  const view = readModPhotoText(dir, "s", text)!;
  assert.equal(view.text, "Look at these\nplease");
  assert.deepEqual(view.photos.map(p => [p.data, p.mediaType]), [[PNG, "image/png"], [JPEG, "image/jpeg"]]);
  assert.equal(modPhotoText("", files), `${photoLine(files[0]!)}\n${photoLine(files[1]!)}`);
  assert.equal(readModPhotoText(dir, "s", modPhotoText("  ", [files[0]!]))!.text, "");
});

test("text that merely looks like a photo line is not read: other folders, other names, missing files", t => {
  const dir = root(t);
  const [file] = writeModPhotos(dir, "s", "i", [PNG]);
  const outside = path.join(path.dirname(dir), "secret.png");
  fs.writeFileSync(outside, Buffer.from(PNG, "base64"));
  for (const bad of [outside, path.join(dir, "..", "secret.png"), path.join(dir, "s", "..", "..", "secret.png"), path.join(dir, "s", "x", "i-1.png"), path.join(dir, "i-1.png"), path.join(dir, "s", "nothing-1.png")]) {
    assert.equal(readModPhotoText(dir, "s", `Hi\n\n${photoLine(bad)}`), null, bad);
  }
  assert.equal(readModPhotoText(dir, "s", "no photo here"), null);
  assert.equal(readModPhotoText(dir, "s", `Hi ${photoLine(file!)}`), null, "the line must stand alone after a blank line");
  assert.equal(readModPhotoText(dir, "s", `Hi\n${photoLine(file!)}`), null);
});

test("a photo line is an attachment only for the session whose folder holds the file", t => {
  const dir = root(t);
  const [mine] = writeModPhotos(dir, "mine", "i", [PNG]);
  const [theirs] = writeModPhotos(dir, "theirs", "i", [PNG]);
  assert.equal(readModPhotoText(dir, "mine", modPhotoText("Look", [mine!]))!.photos.length, 1);
  // The same text quoted in another session (or a later message quoting an old instruction) stays as typed.
  assert.equal(readModPhotoText(dir, "mine", modPhotoText("Look", [theirs!])), null);
  assert.equal(readModPhotoText(dir, "theirs", modPhotoText("Look", [mine!])), null);
  assert.equal(readModPhotoText(dir, "mine", modPhotoText("Look", [mine!, theirs!])), null, "one foreign path makes the whole text typed");
});
