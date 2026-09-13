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

// The Ripple family mark (same geometry as BodyRipple's assets/logo.svg, 1024 grid): a solid core
// (r 128), a full ring (r 245, stroke 56, 62%), and a 270° arc from the top clockwise to the left
// (r 404, stroke 56, 28%). Tray variants, black on transparent (macOS tints template images):
//   ok   : core + ring + arc      warn : core + ring      down : hollow core only
const ARC_START = -Math.PI / 2; // top
function arcAlpha(x: number, y: number, cx: number, cy: number, r: number, w: number, sweep: number): number {
  let ang = Math.atan2(y - cy, x - cx) - ARC_START;
  while (ang < 0) ang += Math.PI * 2;
  if (ang <= sweep) return ring(x, y, cx, cy, r, w);
  // round caps
  const e0 = [cx + r * Math.cos(ARC_START), cy + r * Math.sin(ARC_START)];
  const e1 = [cx + r * Math.cos(ARC_START + sweep), cy + r * Math.sin(ARC_START + sweep)];
  const d = Math.min(Math.hypot(x - e0[0]!, y - e0[1]!), Math.hypot(x - e1[0]!, y - e1[1]!));
  return Math.max(0, Math.min(1, w / 2 - d + 0.5));
}
function draw(variant: Variant, scale: number) {
  const s = scale;
  const c = 11 * s;
  const w = 1.6 * s;
  return (x: number, y: number): number => {
    const d = Math.hypot(x - c, y - c);
    let a = 0;
    if (variant === "down") a = Math.max(0, Math.min(1, w / 2 - Math.abs(d - 2.2 * s) + 0.5));
    else a = Math.max(0, Math.min(1, 2.6 * s - d + 0.5));
    if (variant !== "down") a = Math.max(a, ring(x, y, c, c, 5.4 * s, w));
    if (variant === "ok") a = Math.max(a, arcAlpha(x, y, c, c, 9.2 * s, w, Math.PI * 1.5));
    return a;
  };
}

for (const v of ["ok", "warn", "down"] as Variant[]) {
  const base = v === "ok" ? "trayTemplate" : v === "warn" ? "trayWarnTemplate" : "trayDownTemplate";
  fs.writeFileSync(path.join(out, `${base}.png`), png(22, (x, y) => [0, 0, 0, Math.round(draw(v, 1)(x, y) * 255)]));
  fs.writeFileSync(path.join(out, `${base}@2x.png`), png(44, (x, y) => [0, 0, 0, Math.round(draw(v, 2)(x, y) * 255)]));
}
// 1024px application icon = BodyRipple's logo.svg geometry, drawn on the macOS grid (824px rounded
// square, radius ≈22.4%, centred on the 1024 canvas). Gradients run along the diagonal like the SVG.
function roundedSquareAlpha(x: number, y: number, x0: number, y0: number, w: number, r: number): number {
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + w - r));
  return Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
}
function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
function appIcon(x: number, y: number): [number, number, number, number] {
  const size = 1024;
  const margin = 100;
  const w = size - margin * 2;
  const shape = roundedSquareAlpha(x, y, margin, margin, w, 0.2237 * w);
  if (shape <= 0) return [0, 0, 0, 0];
  const k = w / 1024; // SVG units → canvas
  const c = size / 2;
  const u = (x - c) / k + 512; // back to the SVG's 1024 grid
  const v = (y - c) / k + 512;
  const diag = ((u - 108) + (v - 108)) / (2 * 808); // 0 at top-left of the ring box, 1 at bottom-right
  const core = lerp3([0x9f, 0x8c, 0xf2], [0x51, 0x40, 0xaa], ((u - 270) + (v - 270)) / (2 * 484));
  const ringC = lerp3([0xa9, 0x99, 0xf4], [0x55, 0x40, 0xb3], diag);
  const d = Math.hypot(u - 512, v - 512);
  const px = (rgb: [number, number, number], a: number, base: [number, number, number]): [number, number, number] => lerp3(base, rgb, a);
  let rgb: [number, number, number] = [0xfb, 0xf8, 0xf4];
  const arcA = arcAlpha(u, v, 512, 512, 404, 56, Math.PI * 1.5) * 0.28;
  rgb = px(ringC, arcA, rgb);
  const ringA = ring(u, v, 512, 512, 245, 56) * 0.62;
  rgb = px(ringC, ringA, rgb);
  const coreA = Math.max(0, Math.min(1, 128 - d + 0.5));
  rgb = px(core, coreA, rgb);
  return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), Math.round(shape * 255)];
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
