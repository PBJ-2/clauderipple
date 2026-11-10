// Claude's files are read-only. Group IDs refer to app sessionId, not cliSessionId.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { object } from "./bridge-client.ts";
import { SidebarStorage } from "./sidebar-storage.ts";
import { windowsDesktopRoot } from "./desktop-paths.ts";
import type { SessionSummary } from "./protocol.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const string = (v: unknown): string => typeof v === "string" ? v : "";
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const UNGROUPED = "sidebar:ungrouped";
export const PHONE_GROUP = "sidebar:phone";
export interface SidebarSession { cliSessionId: string; sessionId: string; title: string; unread: boolean; archived: boolean; hidden?: boolean; group: string; order: number; activity: number; created: number }
/** `superseded`: CLI session ids an app session has moved on from (resume, compact, handoff); its row is the one that lists. */
export interface SidebarSnapshot { groups: { name: string; sessions: string[] }[]; sessions: Map<string, SidebarSession>; superseded: Set<string> }
export interface SidebarOptions { root?: string; now?: () => number; onError?: (error: unknown) => void }

/** Verified on Windows with bundled CLI 2.1.304: app data moved out of Roaming/Claude.
 * Enable only a single on-disk layout we recognize, never a guessed AppData path. */
export function windowsSidebarRoot(localAppData = process.env.LOCALAPPDATA): string | undefined {
  return windowsDesktopRoot(localAppData);
}

export class DesktopSidebar {
  private root: string;
  private storage: SidebarStorage;
  private cache = new Map<string, { stamp: string; value: unknown }>();
  private at = -Infinity;
  private current: SidebarSnapshot = { groups: [], sessions: new Map(), superseded: new Set() };
  private opts: SidebarOptions;
  constructor(opts: SidebarOptions = {}) {
    this.opts = opts;
    this.root = opts.root ?? path.join(os.homedir(), "Library", "Application Support", "Claude");
    this.storage = new SidebarStorage(path.join(this.root, "Local Storage", "leveldb"));
  }
  private json(file: string): unknown {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new Error("Non-regular desktop sidebar file");
      const stamp = `${stat.mtimeMs}:${stat.size}`, cached = this.cache.get(file);
      if (cached?.stamp === stamp) return cached.value;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let value: unknown;
      try { value = JSON.parse(fs.readFileSync(fd, "utf8")) as unknown; } finally { fs.closeSync(fd); }
      this.cache.set(file, { stamp, value }); return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache.delete(file); return null;
    }
  }
  read(): SidebarSnapshot {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.at < 3000) return this.current;
    try { return this.refresh(now); }
    catch (error) {
      this.at = now;
      if (!this.opts.onError) throw error;
      this.opts.onError(error);
      return this.current;
    }
  }
  private refresh(now: number): SidebarSnapshot {
    // Publish atomically; a racing/invalid external file never replaces a good snapshot.
    const prefs = object(object(this.json(path.join(this.root, "claude_desktop_config.json")))?.preferences);
    const epitaxy = object(prefs?.epitaxyPrefs);
    const scopes = object(epitaxy?.["dframe-group-scopes"]);
    const sections = object(epitaxy?.["dframe-code-sections"]);
    const config = object(this.json(path.join(this.root, "config.json")));
    const account = string(config?.lastKnownAccountUuid);
    const scopeKeys = [...new Set([...Object.keys(scopes ?? {}), ...Object.keys(sections ?? {})])]
      .filter(k => k.split("/").every(v => UUID.test(v)) && k.split("/").length === 2 && (!account || k.startsWith(account + "/")));
    const unreadState = object(object(this.storage.read("epitaxy-unread-v1"))?.state);
    const unread = new Set(array(unreadState?.unreadIds).filter((v): v is string => typeof v === "string"));
    const result: SidebarSnapshot = { groups: [], sessions: new Map(), superseded: new Set() };
    for (const scope of scopeKeys) this.scope(scope, object(scopes?.[scope]), object(sections?.[scope]), epitaxy, unread, result);
    this.current = result; this.at = now; return result;
  }
  private scope(scope: string, groups: Record<string, unknown> | null, layout: Record<string, unknown> | null, prefs: Record<string, unknown> | null, unread: Set<string>, result: SidebarSnapshot): void {
    const dir = path.join(this.root, "claude-code-sessions", scope);
    let names: string[];
    try { names = fs.readdirSync(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const archiveIndex = object(this.json(path.join(dir, "archived-sessions.idx")));
    const archived = new Set(array(archiveIndex?.archived).filter((v): v is string => typeof v === "string"));
    const assignments = object(groups?.assignments), orders = object(groups?.order);
    const manual = array(groups?.groups).map(object).filter(g => g && typeof g.id === "string");
    const rows: SidebarSession[] = [];
    for (const name of names.filter(n => /^local_[0-9a-f-]+\.json$/i.test(n))) {
      const v = object(this.json(path.join(dir, name)));
      if (!v || !UUID.test(string(v.cliSessionId))) continue;
      const sessionId = string(v.sessionId) || name.slice(0, -5), group = string(assignments?.[`code:${sessionId}`]);
      for (const prior of array(v.priorCliSessionIds)) if (typeof prior === "string" && UUID.test(prior)) result.superseded.add(prior);
      const routine = typeof v.scheduledTaskId === "string" && v.scheduledTaskId.length > 0;
      // The app persists its unread set to Local Storage late; a session focused in the app after
      // its last activity is read even while the stored set still lists it (2026-10-13: 데이리플
      // showed yellow on the phone while the Mac, which had it open, showed it working).
      const focused = number(v.lastFocusedAt), active = number(v.lastActivityAt);
      const seen = focused > 0 && active > 0 && focused >= active;
      rows.push({ cliSessionId: string(v.cliSessionId), sessionId, title: string(v.title), unread: unread.has(sessionId) && !seen,
        archived: v.isArchived === true || archived.has(sessionId), group: routine ? "routines" : manual.some(g => g?.id === group) ? group : "sessions",
        order: 0, activity: number(v.lastActivityAt) || number(v.createdAt), created: number(v.createdAt) });
    }
    const pinned = new Set(array(prefs?.["starred-local-code-sessions"]).filter((v): v is string => typeof v === "string"));
    const configured = array(layout?.sections).map(object).filter((v): v is Record<string, unknown> => v !== null);
    const sectionList: Record<string, unknown>[] = configured.length ? configured.sort((a, b) => number(a.order) - number(b.order)) :
      [...manual.map(g => ({ id: g?.id, kind: "manual", name: g?.name })), { id: "sessions", kind: "sessions", name: "" }];
    const consumed = new Set<string>();
    for (const section of sectionList) {
      if (section.shown === false) continue;
      const id = string(section.id), groupName = section.kind === "pinned" ? "sidebar:pinned" : section.kind === "routines" ? "sidebar:routines" : section.kind === "sessions" ? UNGROUPED : string(section.name);
      if (!groupName) continue;
      const members = new Set(array(section.members).filter((v): v is string => typeof v === "string"));
      const selected = rows.filter(r => !r.archived && !consumed.has(r.cliSessionId) && (section.kind === "pinned" ? pinned.has(r.sessionId) : r.group === id || members.has(`code:${r.sessionId}`)));
      const order = array(orders?.[id]);
      selected.sort((a, b) => {
        let delta: number;
        if (section.sortBy === "manual") {
          const rank = (r: SidebarSession) => { const i = order.indexOf(`code:${r.sessionId}`); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
          delta = rank(a) - rank(b);
        } else if (section.sortBy === "title" || section.sortBy === "name") delta = a.title.localeCompare(b.title);
        else if (section.sortBy === "created") delta = b.created - a.created;
        else delta = b.activity - a.activity;
        return (section.ascending === true ? -delta : delta) || a.sessionId.localeCompare(b.sessionId);
      });
      const group = { name: groupName, sessions: selected.map(r => r.cliSessionId) };
      result.groups.push(group);
      selected.forEach((r, order) => { consumed.add(r.cliSessionId); result.sessions.set(r.cliSessionId, { ...r, group: groupName, order }); });
    }
    // Archived rows must reach the phone's archive; hidden sections are a separate exclusion.
    for (const r of rows) if (!result.sessions.has(r.cliSessionId)) result.sessions.set(r.cliSessionId, { ...r, ...(!r.archived ? { hidden: true } : {}) });
  }
  /** The activity time of a row the app still lists as unread, for a phone that has just read it;
   * undefined when the app already counts it read (focused since) or does not list it at all. */
  unreadActivity(cliId: string): number | undefined {
    const row = this.read().sessions.get(cliId);
    return row?.unread ? row.activity : undefined;
  }

  /** `superseded`: CLI ids the host knows an app session moved on from (a /clear in place it ran), on top of the app's own. */
  join(sessions: SessionSummary[], cliId: (id: string) => string, pendingAppSession: (id: string) => boolean = () => false, superseded: ReadonlySet<string> = new Set()): SessionSummary[] {
    const sidebar = this.read();
    if (!sidebar.groups.length) return sessions;
    return sessions.flatMap(s => {
      const row = sidebar.sessions.get(cliId(s.id));
      if (row?.hidden) return [];
      // The host keeps one record per CLI session id; an app session that has moved on from one
      // (2026-10-13: 클로드리플 and 클로드리플2 each listed twice, the old half stuck at "42 min").
      // A /clear moves on without naming the old id (2026-10-23: 맘보2 twice, the old half at "1 hour"):
      // an app session's record that no app session holds now is not in the app's sidebar either.
      if (!row && (sidebar.superseded.has(cliId(s.id)) || superseded.has(cliId(s.id)) || s.desktopBridge && !pendingAppSession(s.id))) return [];
      if (!row) return [{ ...s, group: s.origin === "desktop" ? UNGROUPED : PHONE_GROUP }];
      return [{ ...s, ...(row.archived ? { archived: true } : {}), title: row.title.trim() || s.title, unread: row.unread, group: row.group, order: row.order, updatedAt: row.activity }];
    });
  }
}
