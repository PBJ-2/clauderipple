#!/usr/bin/env node
// Generates the three 22×22 (and @2x 44×44) template tray icons as PNGs with no dependencies:
// a "ripple" of concentric arcs. Template images are black + alpha; macOS tints them.
//   ok   : three full rings
//   warn : rings with a gap (broken ring)
//   down : outline circle only
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
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
function png(size: number, pixelAt: (x: number, y: number) => [number, number, number, number]): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x + 0.5, y + 0.5);
      row[1 + x * 4] = r;
      row[2 + x * 4] = g;
      row[3 + x * 4] = b;
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

// A drop above its ripple: a teardrop at the top, two flat elliptical rings beneath it.
//   ok   : drop + two rings
//   warn : drop + inner ring only
//   down : hollow drop, no rings
function ellipseRing(x: number, y: number, cx: number, cy: number, rx: number, ry: number, w: number): number {
  const dn = Math.hypot((x - cx) / rx, (y - cy) / ry); // 1 on the ellipse
  const d = Math.abs(dn - 1) * ((rx + ry) / 2); // approximate pixel distance to the curve
  return Math.max(0, Math.min(1, w / 2 - d + 0.5));
}
function inTriangle(px: number, py: number, a: number[], b: number[], c: number[]): boolean {
  const s1 = (b[0]! - a[0]!) * (py - a[1]!) - (b[1]! - a[1]!) * (px - a[0]!);
  const s2 = (c[0]! - b[0]!) * (py - b[1]!) - (c[1]! - b[1]!) * (px - b[0]!);
  const s3 = (a[0]! - c[0]!) * (py - c[1]!) - (a[1]! - c[1]!) * (px - c[0]!);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
function draw(variant: Variant, scale: number) {
  const s = scale;
  const cx = 11 * s;
  const dropY = 8.2 * s;
  const dropR = 2.9 * s;
  const apex = [cx, 2.6 * s];
  const w = 1.6 * s;
  const ringY = 15.6 * s;
  // teardrop = circle(R) ∪ triangle(apex, tangent points); the outline is the shape minus a smaller
  // drop with the same centre and an apex pulled down so the tip keeps its point.
  const dropShape = (px: number, py: number, R: number, apexY: number): boolean => {
    const d = Math.hypot(px - cx, py - dropY);
    if (d < R) return true;
    const L = dropY - apexY;
    if (L <= R) return false;
    const t = Math.asin(R / L);
    const p1 = [cx - R * Math.cos(t), dropY - R * Math.sin(t)];
    const p2 = [cx + R * Math.cos(t), dropY - R * Math.sin(t)];
    return inTriangle(px, py, [cx, apexY], p1, p2);
  };
  return (x: number, y: number): number => {
    let a = 0;
    const outer = dropShape(x, y, dropR, apex[1]!);
    if (variant === "down") a = outer && !dropShape(x, y, dropR - w, apex[1]! + 1.7 * w) ? 1 : 0;
    else a = outer ? 1 : 0;
    const rings = variant === "ok" ? [[4.2, 1.5], [8.6, 3.0]] : variant === "warn" ? [[4.2, 1.5]] : [];
    for (const [rx, ry] of rings) a = Math.max(a, ellipseRing(x, y, cx, ringY, rx! * s, ry! * s, w));
    return a;
  };
}

for (const v of ["ok", "warn", "down"] as Variant[]) {
  const base = v === "ok" ? "trayTemplate" : v === "warn" ? "trayWarnTemplate" : "trayDownTemplate";
  fs.writeFileSync(path.join(out, `${base}.png`), png(22, (x, y) => [0, 0, 0, Math.round(draw(v, 1)(x, y) * 255)]));
  fs.writeFileSync(path.join(out, `${base}@2x.png`), png(44, (x, y) => [0, 0, 0, Math.round(draw(v, 2)(x, y) * 255)]));
}
// 1024px application icon in the macOS style: an 824px rounded square (radius ≈22.4%) centred on the
// 1024 canvas, a deep-blue→sky gradient with a soft top highlight, the drop and its ripple in white
// (rings fading outward), and a faint drop shadow under the drop.
function roundedSquareAlpha(x: number, y: number, x0: number, y0: number, w: number, r: number): number {
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + w - r));
  const d = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, r - d + 0.5));
}
function appIcon(x: number, y: number): [number, number, number, number] {
  const size = 1024;
  const margin = 100;
  const w = size - margin * 2;
  const r = 0.2237 * w;
  const shape = roundedSquareAlpha(x, y, margin, margin, w, r);
  if (shape <= 0) return [0, 0, 0, 0];
  // background gradient: top #4c8dff → bottom #1f4fd6, plus a soft radial highlight top-left
  const t = (y - margin) / w;
  let R = 76 + (31 - 76) * t, G = 141 + (79 - 141) * t, B = 255 + (214 - 255) * t;
  const hl = Math.max(0, 1 - Math.hypot(x - (margin + w * 0.3), y - (margin + w * 0.15)) / (w * 0.9)) * 0.18;
  R += (255 - R) * hl; G += (255 - G) * hl; B += (255 - B) * hl;
  // glyph: reuse the tray drawing scaled into the square (22-unit grid → 0.7 of the square, centred)
  const g = w * 0.72 / 22;
  const gx = margin + (w - 22 * g) / 2;
  const gy = margin + (w - 22 * g) / 2 - g * 0.6;
  const glyph = draw("ok", g)(x - gx, y - gy);
  // rings fade with distance from the drop's centre line
  const ringFade = y > gy + 12.5 * g ? Math.max(0.55, 1 - (y - (gy + 12.5 * g)) / (12 * g)) : 1;
  const a = glyph * ringFade;
  // faint shadow below the drop
  const sh = draw("ok", g)(x - gx, y - gy - g * 0.9) * 0.22;
  R = R * (1 - sh); G = G * (1 - sh); B = B * (1 - sh);
  R = R + (255 - R) * a; G = G + (255 - G) * a; B = B + (255 - B) * a;
  return [Math.round(R), Math.round(G), Math.round(B), Math.round(shape * 255)];
}

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
fs.mkdirSync(build, { recursive: true });
const iconPng = path.join(build, "icon.png");
fs.writeFileSync(iconPng, png(1024, appIcon));
const iconset = path.join(build, "icon.iconset");
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  const source = png(size, (x, y) => appIcon((x / size) * 1024, (y / size) * 1024));
  fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), source);
  fs.writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), png(size * 2, (x, y) => appIcon((x / (size * 2)) * 1024, (y / (size * 2)) * 1024)));
}
const iconIcns = path.join(build, "icon.icns");
fs.rmSync(iconIcns, { force: true });
execFileSync("iconutil", ["-c", "icns", iconset, "-o", iconIcns]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`icons written to ${out}; app icon written to ${iconPng} and ${iconIcns}`);
