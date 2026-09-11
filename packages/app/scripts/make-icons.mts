#!/usr/bin/env node
// Generates the three 22×22 (and @2x 44×44) template tray icons as PNGs with no dependencies:
// a "ripple" of concentric arcs. Template images are black + alpha; macOS tints them.
//   ok   : three full rings
//   warn : rings with a gap (broken ring)
//   down : outline circle only
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
fs.mkdirSync(out, { recursive: true });

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number, alphaAt: (x: number, y: number) => number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const a = Math.round(Math.max(0, Math.min(1, alphaAt(x + 0.5, y + 0.5))) * 255);
      row[1 + x * 4] = 0;
      row[2 + x * 4] = 0;
      row[3 + x * 4] = 0;
      row[4 + x * 4] = a;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

// signed distance of a ring: |dist - r| < w/2  → inside
function ring(x: number, y: number, cx: number, cy: number, r: number, w: number): number {
  const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
  return Math.max(0, Math.min(1, w / 2 - d + 0.5));
}

type Variant = "ok" | "warn" | "down";
function draw(variant: Variant, scale: number) {
  const size = 22 * scale;
  const c = size / 2;
  const w = 1.6 * scale;
  return (x: number, y: number): number => {
    const radii = variant === "down" ? [8.5] : [3, 6, 9];
    let a = 0;
    for (const r0 of radii) {
      const r = r0 * scale;
      let v = ring(x, y, c, c, r, w);
      if (variant === "warn") {
        // cut a wedge on the upper-right so the rings read as broken
        const ang = Math.atan2(y - c, x - c);
        if (ang > -1.2 && ang < -0.3) v = 0;
      }
      a = Math.max(a, v);
    }
    if (variant !== "down" && Math.hypot(x - c, y - c) < 1.1 * scale) a = 1; // center dot
    return a;
  };
}

for (const v of ["ok", "warn", "down"] as Variant[]) {
  const base = v === "ok" ? "trayTemplate" : v === "warn" ? "trayWarnTemplate" : "trayDownTemplate";
  fs.writeFileSync(path.join(out, `${base}.png`), png(22, draw(v, 1)));
  fs.writeFileSync(path.join(out, `${base}@2x.png`), png(44, draw(v, 2)));
}
console.log(`icons written to ${out}`);
