// Photos for a Claude app session reach it as text: the mod can only submit a prompt, and a prompt
// cannot carry image bytes. The host writes each photo to a file of its own and tells Claude, in the
// message, to open it with the Read tool. This module is the one place that words that line, so what the
// mod submits, what the echo match compares and what the phone shows (the person's text with its photo
// thumbnails, not a path line) always agree.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageMediaType, type ImageMediaType } from "./images.ts";
import { ATTACHMENT_CAP } from "./protocol.ts";

const EXTENSION: Record<ImageMediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const LINE = /^\[Attached photo: (.+) — open it with the Read tool to see it\]$/;
const NAME = /^[\w-]+\.(?:png|jpg|gif|webp)$/;
/** The line that tells Claude where a photo is. */
export const photoLine = (file: string): string => `[Attached photo: ${file} — open it with the Read tool to see it]`;

/** The person's text, then one photo line each, after a blank line. A photo alone is just the lines. */
export function modPhotoText(text: string, files: readonly string[]): string {
  const lines = files.map(photoLine).join("\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
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
  const lines = text.split("\n");
  let head = lines.length;
  while (head > 0 && LINE.test(lines[head - 1]!)) head--;
  if (head === lines.length || head > 0 && lines[head - 1] !== "") return null;
  const base = modPhotoDir(root, session);
  const photos: ModPhotoView["photos"] = [];
  for (const line of lines.slice(head)) {
    const file = path.resolve(LINE.exec(line)![1]!);
    const relative = path.relative(base, file).split(path.sep);
    if (relative.length !== 1 || !NAME.test(relative[0]!)) return null;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > ATTACHMENT_CAP) return null;
      const bytes = fs.readFileSync(file);
      const mediaType = imageMediaType(bytes);
      if (!mediaType) return null;
      photos.push({ data: bytes.toString("base64"), mediaType });
    } catch { return null; }
  }
  return { text: head === 0 ? "" : lines.slice(0, head - 1).join("\n"), photos };
}

/** Removes one item's photos (its offer failed, so nothing refers to them). */
export function removeModPhotos(files: readonly string[]): void {
  for (const file of files) fs.rmSync(file, { force: true });
}
