// Append-only log file with size-based rotation. Never logs request bodies or headers.

import fs from "node:fs";
import path from "node:path";

export class Logger {
  private fd: number | null = null;
  private bytes = 0;
  private writesSinceCheck = 0;
  private readonly file: string | null;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly echo: boolean;

  constructor(file: string | null, maxBytes: number, keep: number, echo: boolean) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.echo = echo;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.open();
    }
  }

  private open(): void {
    if (!this.file) return;
    this.fd = fs.openSync(this.file, "a");
    try {
      this.bytes = fs.fstatSync(this.fd).size;
    } catch {
      this.bytes = 0;
    }
  }

  private rotate(): void {
    if (!this.file || this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (this.keep >= 1) fs.renameSync(this.file, `${this.file}.1`);
    else fs.unlinkSync(this.file);
    this.open();
  }

  line(level: "info" | "warn" | "error", msg: string): void {
    const ts = new Date().toISOString().slice(5, 19).replace("T", " ");
    const out = `${ts} ${level === "info" ? "" : level.toUpperCase() + " "}${msg}\n`;
    if (this.echo || this.fd === null) process.stdout.write(out);
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, out);
        this.bytes += Buffer.byteLength(out);
        if (++this.writesSinceCheck >= 50) {
          this.writesSinceCheck = 0;
          if (this.bytes >= this.maxBytes) this.rotate();
        }
      } catch {
        /* logging must never take the router down */
      }
    }
  }

  info(msg: string): void {
    this.line("info", msg);
  }
  warn(msg: string): void {
    this.line("warn", msg);
  }
  error(msg: string): void {
    this.line("error", msg);
  }
}
