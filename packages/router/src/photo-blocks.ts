// Phone photos in a Claude app session reach the model as image blocks, not as a path to open.
//
// The desktop mod can only submit text, so the host (packages/remote/src/mod-photos.ts) writes each photo
// to <host dir>/mod-photos/<session>/<name> and ends the person's message with one
// `📷 Photo (open with Read): <path>` line per photo. The engine lets no plugin hook rewrite the outgoing
// request (`turn.step` pins the messages), but every request passes through this router: here a user text
// block that ends in such lines gets the photos' bytes as image blocks right after it. The line stays in the
// text as it is, so the person's own transcript is untouched; only the request the model reads changes.
//
// The prompt cache is a prefix match, and the whole history is sent again every turn, so a message must
// be rewritten the same way every time. That holds because the rewrite depends on nothing but the
// message, the file it names (a file name is unique per item and never rewritten), and the router's
// memory of files the API refused (below), and its limits are counted oldest message first: a photo added
// later can only be the one that goes over, never change an earlier one.
//
// A photo is given only when the request's session is the one whose folder holds it (a line pasted into
// another session names a file that is not this session's), and only to a target that takes images
// (proxy.ts decides; a text-only model gets the line and opens the file with Read). A photo the API
// refused is remembered here, so the retry without it and every later replay read the same.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { remoteHome } from "../../remote/src/config.ts";
import { imageMediaType } from "../../remote/src/images.ts";
import { isModPhotoFile, splitPhotoLines, withReadHint } from "../../remote/src/mod-photos.ts";
import { writeJsonAtomic } from "./locked-file.ts";

/** The API takes 5 MB of base64 per image: 3.5 MB of bytes leaves room for the encoding. */
const IMAGE_BYTES = 3.5 * 1024 * 1024;
/** What one request may carry of photos, bytes and count, so a long thread of photos never nears the request cap. */
const TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 16;
/** The whole serialized request, photos and the rest of the body together, stays under this (the API cap is 32 MB). */
export const REQUEST_LIMIT = 30 * 1024 * 1024;
/** Photos kept decoded between requests (the same few are re-sent every turn). */
const CACHE_BYTES = 32 * 1024 * 1024;
/** Refused photos remembered (a few bytes each). */
const BLOCKED_MAX = 500;

/** Where the remote host on this machine keeps the photos it hands to app sessions. */
export const modPhotosRoot = (): string => path.join(remoteHome(), "mod-photos");

/** The folder's name: it is in the path of every photo line, so a request that lacks it holds none. */
export const modPhotosFolder = (root: string): string => path.basename(root);

type Block = Record<string, unknown>;
type Photo = { mediaType: string; data: string; size: number };

const held = new Map<string, Photo>();
let heldBytes = 0;

async function load(file: string): Promise<Photo | null> {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size > IMAGE_BYTES) return null;
    const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
    const cached = held.get(key);
    if (cached) { held.delete(key); held.set(key, cached); return cached; }
    const bytes = await fsp.readFile(file);
    const mediaType = imageMediaType(bytes);
    if (!mediaType || bytes.length > IMAGE_BYTES) return null;
    const photo = { mediaType, data: bytes.toString("base64"), size: bytes.length };
    held.set(key, photo);
    heldBytes += photo.size;
    for (const [oldest, old] of held) {
      if (heldBytes <= CACHE_BYTES || held.size <= 1) break;
      held.delete(oldest);
      heldBytes -= old.size;
    }
    return photo;
  } catch { return null; }
}

/**
 * The photo files an upstream refused as images, kept in a small file of the router's data dir so they stay
 * text across restarts: a file never changes, so one refusal is final.
 */
export class PhotoBlocklist {
  private files: string[] | undefined;
  private readonly file: string;
  constructor(home: string) { this.file = path.join(home, "photo-blocked.json"); }

  private list(): string[] {
    if (!this.files) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
        this.files = Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === "string") : [];
      } catch { this.files = []; }
    }
    return this.files;
  }

  has(file: string): boolean { return this.list().includes(path.resolve(file)); }

  add(files: readonly string[]): void {
    const list = this.list();
    for (const file of files) {
      const resolved = path.resolve(file);
      if (!list.includes(resolved)) list.push(resolved);
    }
    if (list.length > BLOCKED_MAX) list.splice(0, list.length - BLOCKED_MAX);
    try { writeJsonAtomic(this.file, list); } catch { /* kept in memory; the next refusal writes it again */ }
  }
}

/**
 * Words the photo lines of a request for a model that is not given the images: a short `📷 Photo: <path>`
 * line (an earlier wording) says to open the file. Returns whether the request changed. Only user text
 * blocks that end in photo lines of the host's folder are looked at.
 */
export function hintModPhotos(request: { messages?: unknown }, root: string): boolean {
  if (!Array.isArray(request.messages)) return false;
  let changed = false;
  const hint = (text: string): string => {
    const split = splitPhotoLines(text);
    return split && split.files.every(file => isModPhotoFile(root, file)) ? withReadHint(text) : text;
  };
  for (const message of request.messages as Block[]) {
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") {
      const text = hint(message.content);
      if (text !== message.content) { message.content = text; changed = true; }
    } else if (Array.isArray(message.content)) {
      for (const block of message.content as Block[]) {
        if (!block || block.type !== "text" || typeof block.text !== "string") continue;
        const text = hint(block.text);
        if (text !== block.text) { block.text = text; changed = true; }
      }
    }
  }
  return changed;
}

export type AttachOptions = {
  /** The Claude Code session the request belongs to. Only its own photos are given; none without it. */
  session: string | undefined;
  /** Files an upstream refused: they are not given again. */
  blocked?: Pick<PhotoBlocklist, "has">;
  /** What the request may still grow by, in bytes of JSON (`REQUEST_LIMIT` less the body as it is). */
  room: number;
};

/**
 * Gives the photos named by the photo lines that end a user text block, in the host's own folder `root` and
 * this request's session, to the model as image blocks after that block. The text is left as it is. A photo
 * it cannot give (too big, gone, refused before, over the request's budget, not an image, another session's)
 * stays the line, which tells the model to open the file with Read. Returns the files it gave, in order: none
 * means the request is unchanged. Anything outside `root` is left alone, as is text that only looks like a
 * photo line: a tool result, an assistant message, a path somewhere else.
 */
export async function attachModPhotos(request: { messages?: unknown }, root: string, options: AttachOptions): Promise<string[]> {
  const given: string[] = [];
  const { session } = options;
  if (!session || !Array.isArray(request.messages)) return given;
  const budget = { images: 0, bytes: 0, json: 0 };

  const expand = async (block: Block): Promise<Block[] | null> => {
    const split = typeof block.text === "string" ? splitPhotoLines(block.text) : null;
    if (!split) return null;
    const images: Block[] = [];
    for (const name of split.files) {
      const file = path.resolve(name);
      if (!isModPhotoFile(root, file, session) || options.blocked?.has(file)) continue;
      if (budget.images >= MAX_IMAGES || budget.bytes >= TOTAL_BYTES) continue;
      const photo = await load(file);
      if (!photo || budget.bytes + photo.size > TOTAL_BYTES) continue;
      // Each image costs its base64 plus the block around it in the serialized request.
      const cost = photo.data.length + 120;
      if (budget.json + cost > options.room) continue;
      budget.images++;
      budget.bytes += photo.size;
      budget.json += cost;
      given.push(file);
      images.push({ type: "image", source: { type: "base64", media_type: photo.mediaType, data: photo.data } });
    }
    if (images.length === 0) return null;
    // A breakpoint that closed the text now closes the photos too, so they are cached with it.
    const { cache_control: cache, ...text } = block;
    if (cache !== undefined) images[images.length - 1]!.cache_control = cache;
    return [text, ...images];
  };

  for (const message of request.messages as Block[]) {
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") {
      const blocks = await expand({ type: "text", text: message.content });
      if (blocks) message.content = blocks;
    } else if (Array.isArray(message.content)) {
      const content: Block[] = [];
      let touched = false;
      for (const block of message.content as Block[]) {
        const blocks = block && block.type === "text" ? await expand(block) : null;
        if (blocks) { content.push(...blocks); touched = true; } else content.push(block);
      }
      if (touched) message.content = content;
    }
  }
  return given;
}
