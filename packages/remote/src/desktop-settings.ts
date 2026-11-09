// Claude Desktop's session records are read-only; never infer a target from a prior CLI id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { object } from "./bridge-client.ts";
import { settingsId } from "./settings-jobs.ts";

export interface AppSettings { appSessionId: string; model: string | undefined; effort: string | undefined }

interface ParsedRecord { cliSessionId: string; settings: AppSettings }
interface CachedFile { size: number; mtimeMs: number; ctimeMs: number; record: ParsedRecord | null }

export class DesktopSettings {
  private root: string;
  private at = -Infinity;
  private current = new Map<string, AppSettings>();
  private files = new Map<string, CachedFile>();
  private now: () => number;
  constructor(root = path.join(os.homedir(), "Library", "Application Support", "Claude"), now: () => number = Date.now) {
    this.now = now;
    this.root = path.join(root, "claude-code-sessions");
  }

  appSessionIdFor(cliSessionId: string): string | undefined { return this.appSettingsFor(cliSessionId)?.appSessionId; }

  appSettingsFor(cliSessionId: string): AppSettings | undefined {
    if (this.now() - this.at >= 3000) this.refresh();
    const value = this.current.get(cliSessionId);
    return value && { ...value };
  }

  private directories(dir: string): string[] {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && settingsId(entry.name)).map(entry => path.join(dir, entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  /** Parses one app record. `undefined`: it could not be read (retried on the next refresh);
   * `null`: it was read but names no usable CLI id (cached until the file changes). */
  private read(file: string, appSessionId: string): ParsedRecord | null | undefined {
    let raw: string;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { raw = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    } catch { return undefined; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    const row = object(parsed);
    if (!row || !settingsId(row.cliSessionId)) return null;
    if (row.sessionId !== undefined && row.sessionId !== appSessionId) return null;
    return { cliSessionId: row.cliSessionId, settings: { appSessionId, model: typeof row.model === "string" ? row.model : undefined, effort: typeof row.effort === "string" ? row.effort : undefined } };
  }

  /** One record the app is mid-write on, or two records naming one CLI id, leaves that record (or id)
   * out rather than failing every lookup: an ambiguous id is never guessed at. The app keeps hundreds
   * of large records, so a file is read and parsed only when its stat changed (the stat is taken
   * before the read, so a write landing in between is seen as a change on the next refresh). */
  private refresh(): void {
    const next = new Map<string, AppSettings>();
    const ambiguous = new Set<string>();
    const seen = new Set<string>();
    for (const account of this.directories(this.root)) for (const scope of this.directories(account)) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(scope, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !/^local_[\w-]{1,94}\.json$/.test(entry.name)) continue;
        const file = path.join(scope, entry.name);
        let stat: fs.Stats;
        try { stat = fs.lstatSync(file); } catch { continue; }
        if (!stat.isFile()) continue; // lstat: a symlink is never followed, as with O_NOFOLLOW below.
        seen.add(file);
        let cached = this.files.get(file);
        if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs || cached.ctimeMs !== stat.ctimeMs) {
          const record = this.read(file, entry.name.slice(0, -5));
          if (record === undefined) { this.files.delete(file); continue; }
          cached = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, record };
          this.files.set(file, cached);
        }
        if (!cached.record) continue;
        if (next.has(cached.record.cliSessionId)) { ambiguous.add(cached.record.cliSessionId); continue; }
        next.set(cached.record.cliSessionId, cached.record.settings);
      }
    }
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
    for (const id of ambiguous) next.delete(id);
    this.current = next; this.at = this.now();
  }
}
