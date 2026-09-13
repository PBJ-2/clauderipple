#!/usr/bin/env node
// Captures README media from the local GUI with Electron (offscreen) and builds an animated GIF
// tour as an animated PNG (APNG) with no dependencies. Usage: node scripts/make-media.mts [adminUrl]
//   → docs/media/{status,mapping,providers,add-provider,clients,logs}.png and docs/media/tour.png (animated)
// Run against an isolated router when the live one holds real keys; the GUI never shows key values,
// but the provider names and model lists are whatever that config contains.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "docs", "media");
const adminUrl = process.argv[2] ?? "http://127.0.0.1:8792";
const W = 1280;
const H = 820;

fs.mkdirSync(out, { recursive: true });

// ---- 1. capture pages with Electron (offscreen, device scale 1) --------------------------------
const pages: { name: string; hash: string; prep?: string }[] = [
  { name: "status", hash: "health" },
  { name: "mapping", hash: "slots" },
  { name: "providers", hash: "providers" },
  { name: "clients", hash: "clients" },
  { name: "logs", hash: "logs" },
  // last: the chooser modal persists across in-page hash navigation
  {
    name: "add-provider",
    hash: "providers",
    prep: "document.getElementById('providers-add') && document.getElementById('providers-add').click()",
  },
];
const capture = `
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: ${W}, height: ${H}, show: false, webPreferences: { offscreen: true, zoomFactor: 1 } });
  win.webContents.setZoomFactor(1);
  for (const p of ${JSON.stringify(pages)}) {
    await win.loadURL(${JSON.stringify(adminUrl)} + "/#" + p.hash);
    await wait(2200);
    if (p.prep) { try { await win.webContents.executeJavaScript(p.prep); } catch {} await wait(600); }
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: ${W}, height: ${H} });
    fs.writeFileSync(${JSON.stringify(out)} + "/" + p.name + ".png", img.toPNG());
  }
  app.quit();
});
`;
const captureFile = path.join(out, ".capture.cjs");
fs.writeFileSync(captureFile, capture);
const electron = path.join(root, "node_modules", ".bin", "electron");
execFileSync(electron, [captureFile], { stdio: "inherit" });
fs.rmSync(captureFile, { force: true });

// ---- 2. decode PNG → RGBA -------------------------------------------------------------------------
function decodePng(buf: Buffer): { w: number; h: number; rgba: Uint8Array } {
  let pos = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG ${bitDepth}/${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const rgba = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]!;
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let v = line[i]!;
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      rgba[(y * w + x) * 4] = line[x * bpp]!;
      rgba[(y * w + x) * 4 + 1] = line[x * bpp + 1]!;
      rgba[(y * w + x) * 4 + 2] = line[x * bpp + 2]!;
      rgba[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
    prev = line;
  }
  return { w, h, rgba };
}

// ---- 3. animated PNG (APNG) — lossless, no palette, rendered animated by every browser incl. GitHub --
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodeRows(rgba: Uint8Array, w: number, h: number): Buffer {
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, o = y * (w * 3 + 1) + 1 + x * 3;
      rows[o] = rgba[i]!; rows[o + 1] = rgba[i + 1]!; rows[o + 2] = rgba[i + 2]!;
    }
  }
  return zlib.deflateSync(rows, { level: 9 });
}
function apng(frames: Uint8Array[], w: number, h: number, delayMs: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // RGB
  parts.push(chunk("IHDR", ihdr));
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(0, 4); // loop forever
  parts.push(chunk("acTL", actl));
  let seq = 0;
  frames.forEach((f, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0); fctl.writeUInt32BE(w, 4); fctl.writeUInt32BE(h, 8); fctl.writeUInt32BE(0, 12); fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(delayMs, 20); fctl.writeUInt16BE(1000, 22); fctl[24] = 0; fctl[25] = 0;
    parts.push(chunk("fcTL", fctl));
    const data = encodeRows(f, w, h);
    if (i === 0) parts.push(chunk("IDAT", data));
    else { const sq = Buffer.alloc(4); sq.writeUInt32BE(seq++); parts.push(chunk("fdAT", Buffer.concat([sq, data]))); }
  });
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function downscale(rgba: Uint8Array, w: number, h: number, tw: number): { w: number; h: number; rgba: Uint8Array } {
  const s = w / tw;
  const th = Math.round(h / s);
  const o = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx0 = Math.floor(x * s), sy0 = Math.floor(y * s), sx1 = Math.min(w, Math.ceil((x + 1) * s)), sy1 = Math.min(h, Math.ceil((y + 1) * s));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { const i = (yy * w + xx) * 4; r += rgba[i]!; g += rgba[i + 1]!; b += rgba[i + 2]!; n++; }
    const j = (y * tw + x) * 4;
    o[j] = r / n; o[j + 1] = g / n; o[j + 2] = b / n; o[j + 3] = 255;
  }
  return { w: tw, h: th, rgba: o };
}

const tour = ["status", "mapping", "providers", "add-provider", "clients", "logs"];
const frames: Uint8Array[] = [];
let fw = 0, fh = 0;
for (const name of tour) {
  const file = path.join(out, `${name}.png`);
  if (!fs.existsSync(file)) continue;
  const img = decodePng(fs.readFileSync(file));
  const small = downscale(img.rgba, img.w, img.h, 960);
  fw = small.w; fh = small.h;
  frames.push(small.rgba);
}
if (frames.length) fs.writeFileSync(path.join(out, "tour.png"), apng(frames, fw, fh, 2200));
console.log(`media written to ${out}: ${fs.readdirSync(out).join(", ")}`);
