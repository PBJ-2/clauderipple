// Photos for a Claude app session reach it as text: the mod can only submit a prompt, and a prompt
// cannot carry image bytes. The host writes each photo to a file of its own and names it, one line per
// photo, in the message. The router then turns those lines into image blocks of the model's request
// (packages/router/src/photo-blocks.ts), so the model sees the photo without a Read call; the person's
// own bubble keeps the short line. This module is the one place that words that line, so what the
// mod submits, what the echo match compares, what the router recognises and what the phone shows (the
// person's text with its photo thumbnails, not a path line) always agree.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageMediaType, type ImageMediaType } from "./images.ts";
import { ATTACHMENT_CAP } from "./protocol.ts";

const EXTENSION: Record<ImageMediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/**
 * The line as it is worded now, then the short `📷 Photo: <path>` (transcripts from local testing hold it) and
 * the earliest wording, which transcripts written before still hold.
 */
const LINES = [/^📷 Photo \(open with Read\): (.+)$/, /^📷 Photo: (.+)$/, /^\[Attached photo: (.+) — open it with the Read tool to see it\]$/];
const SHORT_LINE = /^📷 Photo: (.+)$/;
const NAME = /^[\w-]+\.(?:png|jpg|gif|webp)$/;
const lineFile = (line: string): string | undefined => {
  for (const pattern of LINES) { const match = pattern.exec(line); if (match) return match[1]!; }
  return undefined;
};
/**
 * The line that tells Claude where a photo is. It says how to see it, because the router is not always in
 * the path (direct mode) and the model then has only this line; when the router does hand the photo over as an
 * image it leaves this text as it is.
 */
export const photoLine = (file: string): string => `📷 Photo (open with Read): ${file}`;

/** The person's text, then one photo line each, after a blank line. A photo alone is just the lines. */
export function modPhotoText(text: string, files: readonly string[]): string {
  const lines = files.map(photoLine).join("\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
}

/**
 * The person's text and the photo files a message names: its trailing run of photo lines, after a blank
 * line (or the whole message). Null when it ends in none. Nothing is checked about the files here.
 */
export function splitPhotoLines(text: string): { head: string; files: string[] } | null {
  const lines = text.split("\n");
  let head = lines.length;
  while (head > 0 && lineFile(lines[head - 1]!) !== undefined) head--;
  if (head === lines.length || head > 0 && lines[head - 1] !== "") return null;
  return { head: head === 0 ? "" : lines.slice(0, head - 1).join("\n"), files: lines.slice(head).map(line => lineFile(line)!) };
}

/**
 * The text with its trailing short photo lines (`📷 Photo: <path>`) worded as `photoLine` words them, so the
 * model is told to open the file wherever no image is added. The same text comes back when there are none.
 */
export function withReadHint(text: string): string {
  const split = splitPhotoLines(text);
  if (!split) return text;
  const lines = text.split("\n");
  const first = lines.length - split.files.length;
  if (!lines.slice(first).some(line => SHORT_LINE.test(line))) return text;
  return [...lines.slice(0, first), ...lines.slice(first).map(line => { const match = SHORT_LINE.exec(line); return match ? photoLine(match[1]!) : line; })].join("\n");
}

/**
 * Whether `file` is a photo this host wrote: `<root>/<session>/<name>` and nothing deeper or elsewhere,
 * for `session` when given, any session otherwise.
 */
export function isModPhotoFile(root: string, file: string, session?: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep);
  return relative.length === 2 && relative[0] !== ".." && (session === undefined || relative[0] === safe(session)) && relative[0] === safe(relative[0]!) && NAME.test(relative[1]!);
}

const safe = (value: string): string => value.replace(/[^\w-]/g, "_").slice(0, 100);

/** The folder one session's photos go in. */
export const modPhotoDir = (root: string, session: string): string => path.join(path.resolve(root), safe(session));

/**
 * Writes each photo (base64) under `<root>/<session>/<item>-<n>.<ext>` and returns the absolute paths.
 * The name comes from the queued item, so a retry of the same item rewrites the same files. Throws when
 * a photo is not a PNG, JPEG, GIF or WebP, or is over the attachment cap, before writing any of them.
 */
export function writeModPhotos(root: string, session: string, item: string, photos: readonly string[]): string[] {
  const decoded = photos.map(data => {
    const bytes = Buffer.from(data, "base64");
    const type = imageMediaType(bytes);
    if (!type || bytes.length > ATTACHMENT_CAP) throw new Error("Photo unreadable or over 8 MB.");
    return { bytes, type };
  });
  const dir = modPhotoDir(root, session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return decoded.map(({ bytes, type }, index) => {
    const file = path.join(dir, `${safe(item)}-${index + 1}.${EXTENSION[type]}`);
    const tmp = path.join(dir, `.tmp-${randomUUID()}`);
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  });
}

export interface ModPhotoView { text: string; photos: { data: string; mediaType: ImageMediaType }[] }

/**
 * What the person sent, from the text the mod submitted: the text before the photo lines and the
 * bytes of the photos they name. Only files this host wrote for THIS session (inside its own folder under
 * `root`) are read: a person quoting an earlier photo line, or one from another session, stays text. Null when the
 * text ends in no photo line, or one of the files is not there: it is then shown as typed.
 */
export function readModPhotoText(root: string, session: string, text: string): ModPhotoView | null {
  const split = splitPhotoLines(text);
  if (!split) return null;
  const photos: ModPhotoView["photos"] = [];
  for (const name of split.files) {
    const file = path.resolve(name);
    if (!isModPhotoFile(root, file, session)) return null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > ATTACHMENT_CAP) return null;
      const bytes = fs.readFileSync(file);
      const mediaType = imageMediaType(bytes);
      if (!mediaType) return null;
      photos.push({ data: bytes.toString("base64"), mediaType });
    } catch { return null; }
  }
  return { text: split.head, photos };
}

/** Removes one item's photos (its offer failed, so nothing refers to them). */
export function removeModPhotos(files: readonly string[]): void {
  for (const file of files) fs.rmSync(file, { force: true });
}
