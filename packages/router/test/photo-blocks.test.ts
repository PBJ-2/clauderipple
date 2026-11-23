// Phone photos for Claude app sessions: the lines that end a message become image blocks of the request.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { photoLine } from "../../remote/src/mod-photos.ts";
import { attachModPhotos, hintModPhotos, PhotoBlocklist } from "../src/photo-blocks.ts";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
const JPEG = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
const ROOM = 30 * 1024 * 1024;

function folder(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-blocks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "mod-photos");
}

function photo(root: string, name: string, bytes: Buffer, session = "s1"): string {
  const file = path.join(root, session, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const image = (bytes: Buffer, mediaType: string) => ({ type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } });
const user = (...content: unknown[]) => ({ messages: [{ role: "user", content }] });
const mine = { session: "s1", room: ROOM };

test("the photos a message ends in follow its text block as images; the visible text stays", async t => {
  const root = folder(t);
  const a = photo(root, "i-1.png", PNG), b = photo(root, "i-2.jpg", JPEG);
  const text = `Which one is better?\n\n${photoLine(a)}\n${photoLine(b)}`;
  const request = user({ type: "text", text }, { type: "text", text: "<system-reminder>later</system-reminder>" });
  assert.deepEqual(await attachModPhotos(request, root, mine), [a, b]);
  assert.deepEqual(request.messages[0]!.content, [{ type: "text", text }, image(PNG, "image/png"), image(JPEG, "image/jpeg"), { type: "text", text: "<system-reminder>later</system-reminder>" }]);
});

test("a cache breakpoint on the text moves to the last photo, and a string message becomes blocks", async t => {
  const root = folder(t);
  const a = photo(root, "i-1.png", PNG);
  const request = { messages: [{ role: "user", content: [{ type: "text", text: photoLine(a), cache_control: { type: "ephemeral" } }] }, { role: "user", content: photoLine(a) }] };
  assert.equal((await attachModPhotos(request, root, mine)).length, 2);
  assert.deepEqual(request.messages[0]!.content, [{ type: "text", text: photoLine(a) }, { ...image(PNG, "image/png"), cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(request.messages[1]!.content, [{ type: "text", text: photoLine(a) }, image(PNG, "image/png")]);
});

test("the earlier wordings are read too, and the text is left as written", async t => {
  const root = folder(t);
  const a = photo(root, "i-1.png", PNG), b = photo(root, "i-2.png", PNG);
  const old = `[Attached photo: ${a} — open it with the Read tool to see it]`;
  const short = `📷 Photo: ${b}`;
  const request = user({ type: "text", text: `Hi\n\n${old}\n${short}` });
  assert.deepEqual(await attachModPhotos(request, root, mine), [a, b]);
  assert.deepEqual(request.messages[0]!.content, [{ type: "text", text: `Hi\n\n${old}\n${short}` }, image(PNG, "image/png"), image(PNG, "image/png")]);
});

test("for a model that is given no image, a short photo line is worded to say to open the file", async t => {
  const root = folder(t);
  const a = photo(root, "i-1.png", PNG);
  const old = `[Attached photo: ${a} — open it with the Read tool to see it]`;
  const request = { messages: [{ role: "user", content: `Hi\n\n📷 Photo: ${a}` }, { role: "user", content: [{ type: "text", text: `Hi\n\n${old}` }] }, { role: "user", content: [{ type: "text", text: `Hi\n\n${photoLine(a)}` }] }] };
  assert.equal(hintModPhotos(request, root), true);
  assert.equal(request.messages[0]!.content, `Hi\n\n${photoLine(a)}`);
  assert.deepEqual(request.messages[1]!.content, [{ type: "text", text: `Hi\n\n${old}` }]);
  assert.equal(hintModPhotos(request, root), false, "already worded: nothing more to do");
  const outside = { messages: [{ role: "user", content: `Hi\n\n📷 Photo: ${path.join(path.dirname(root), "x.png")}` }] };
  assert.equal(hintModPhotos(outside, root), false);
});

test("the same history is rewritten to the same request every time, and a new photo leaves the earlier ones as they were", async t => {
  const root = folder(t);
  const a = photo(root, "i-1.png", PNG), b = photo(root, "i-2.jpg", JPEG);
  const history = (...files: string[]) => ({ messages: files.flatMap(file => [{ role: "user", content: [{ type: "text", text: `Look\n\n${photoLine(file)}` }] }, { role: "assistant", content: [{ type: "text", text: "ok" }] }]) });
  const first = history(a), again = history(a), longer = history(a, b);
  await attachModPhotos(first, root, mine); await attachModPhotos(again, root, mine); await attachModPhotos(longer, root, mine);
  assert.equal(JSON.stringify(first), JSON.stringify(again));
  assert.equal(JSON.stringify(longer.messages.slice(0, 2)), JSON.stringify(first.messages));
});

test("only the person's own text blocks are read, and only photos of the host's folder", async t => {
  const root = folder(t);
  const own = photo(root, "i-1.png", PNG);
  const outside = path.join(path.dirname(root), "secret.png");
  fs.writeFileSync(outside, PNG);
  const typed = (text: string) => ({ type: "text", text });
  const request = {
    messages: [
      { role: "assistant", content: [typed(`x\n\n${photoLine(own)}`)] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [typed(`x\n\n${photoLine(own)}`)] }] },
      { role: "user", content: [typed(`x\n\n${photoLine(outside)}`)] },
      { role: "user", content: [typed(`x\n\n${photoLine(path.join(root, "s1", "..", "..", "secret.png"))}`)] },
      { role: "user", content: [typed(`x\n\n${photoLine(path.join(root, "s1", "nested", "i-1.png"))}`)] },
      { role: "user", content: [typed(`${photoLine(own)} and more`)] },
    ],
  };
  const before = JSON.stringify(request);
  assert.deepEqual(await attachModPhotos(request, root, mine), []);
  assert.equal(JSON.stringify(request), before);
});

// 2: a line pasted into another session names a file that is not this session's.
test("a photo is given only to the session whose folder holds it, and to none without a session", async t => {
  const root = folder(t);
  const theirs = photo(root, "i-1.png", PNG, "s2");
  const request = user({ type: "text", text: photoLine(theirs) });
  const before = JSON.stringify(request);
  assert.deepEqual(await attachModPhotos(request, root, mine), [], "s1 asks for s2's photo");
  assert.deepEqual(await attachModPhotos(request, root, { session: undefined, room: ROOM }), [], "no session id on the request");
  assert.equal(JSON.stringify(request), before);
  assert.deepEqual(await attachModPhotos(request, root, { session: "s2", room: ROOM }), [theirs]);
  // The mix: one of each in one message gives only the session's own.
  const own = photo(root, "i-2.png", PNG);
  const mixed = user({ type: "text", text: `${photoLine(theirs)}\n${photoLine(own)}` });
  assert.deepEqual(await attachModPhotos(mixed, root, mine), [own]);
});

test("a photo it cannot give stays its line, and the others are still given", async t => {
  const root = folder(t);
  const good = photo(root, "i-1.png", PNG);
  const big = photo(root, "i-2.png", Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]));
  const notImage = photo(root, "i-3.png", Buffer.from("text"));
  const gone = path.join(root, "s1", "i-4.png");
  const text = [good, big, notImage, gone].map(photoLine).join("\n");
  const request = user({ type: "text", text });
  assert.deepEqual(await attachModPhotos(request, root, mine), [good]);
  assert.deepEqual(request.messages[0]!.content, [{ type: "text", text }, image(PNG, "image/png")]);
});

test("a request carries at most sixteen photos, counted from the oldest message", async t => {
  const root = folder(t);
  const files = Array.from({ length: 18 }, (_, i) => photo(root, `i-${i + 1}.png`, PNG));
  const request = { messages: files.map(file => ({ role: "user", content: [{ type: "text", text: photoLine(file) }] })) };
  await attachModPhotos(request, root, mine);
  const given = request.messages.map(message => message.content.filter((block: { type: string }) => block.type === "image").length);
  assert.deepEqual(given, [...Array(16).fill(1), 0, 0]);
});

// 4: the cap is on the whole body, not just the photos.
test("photos stop where the request would pass its size cap, counting the body it already is", async t => {
  const root = folder(t);
  const big = Buffer.concat([PNG, Buffer.alloc(900 * 1024)]);
  const files = [1, 2, 3].map(i => photo(root, `i-${i}.png`, big));
  const each = Buffer.from(big).toString("base64").length + 120;
  const build = () => ({ messages: files.map(file => ({ role: "user", content: [{ type: "text", text: photoLine(file) }] })) });
  const roomy = build();
  assert.equal((await attachModPhotos(roomy, root, { session: "s1", room: each * 3 })).length, 3);
  const tight = build();
  assert.deepEqual(await attachModPhotos(tight, root, { session: "s1", room: each * 2 + 10 }), [files[0], files[1]], "the third goes over what is left of the cap");
  assert.ok(JSON.stringify(tight).length <= JSON.stringify(build()).length + each * 2 + 10);
  const none = build();
  assert.deepEqual(await attachModPhotos(none, root, { session: "s1", room: 0 }), [], "a body already at the cap gets none");
});

// 1: a file an upstream refused stays text, across restarts.
test("a refused photo is remembered in a file and is not given again", async t => {
  const root = folder(t);
  const a = photo(root, "i-1.png", PNG), b = photo(root, "i-2.png", PNG);
  const home = path.dirname(root), file = path.join(home, "photo-blocked.json");
  new PhotoBlocklist(home).add([a]);
  const blocked = new PhotoBlocklist(home);
  assert.equal(blocked.has(a), true);
  assert.equal(blocked.has(b), false);
  const request = user({ type: "text", text: `${photoLine(a)}\n${photoLine(b)}` });
  assert.deepEqual(await attachModPhotos(request, root, { ...mine, blocked }), [b]);
  const many = new PhotoBlocklist(home);
  many.add(Array.from({ length: 600 }, (_, i) => `/x/${i}.png`));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 500, "the list stays small");
  assert.equal(new PhotoBlocklist(path.join(home, "nowhere")).has(a), false);
});

test("a request without photos is left as it is", async t => {
  const request = { messages: [{ role: "user", content: "hello" }], system: "s" };
  assert.deepEqual(await attachModPhotos(request, folder(t), mine), []);
  assert.deepEqual(await attachModPhotos({}, folder(t), mine), []);
});
