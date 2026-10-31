// One HTTP server: the PWA's files, and one WebSocket that carries everything else. Keeping all
// traffic on the socket is the relay seam: a relay later forwards this one stream (encrypted)
// and nothing about the app changes.
import fs from "node:fs";
import http from "node:http";
import module from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { tokenMatches } from "./config.ts";
import { clientEvent, clientFeatures, settingsResponse } from "./client-compat.ts";
import { chunkFrames } from "./chunks.ts";
import type { Phone } from "./local-control.ts";
import { browse, macConsent, makeFolder, recentFolders } from "./folders.ts";
import { listSessionFolder, readSessionFolderFile } from "./session-folder.ts";
import type { RecentSource } from "./folders.ts";
import { diffScope, diffView } from "./diff.ts";
import { gitInfo } from "./worktree.ts";
import { ATTACHMENT_CAP, CHUNK_MESSAGE_MAX, FRAME_CAP, PING_MS, STALE_MS } from "./protocol.ts";
import type { BlobChunk, ClientMsg, HostInfo, HostMsg, ProviderGroup, ReqOp, RippleStatus } from "./protocol.ts";
import { SEEN_MS, VISIBLE_MS } from "./push.ts";
import type { Notifier } from "./push.ts";
import { OutcomeUnknownError } from "./receipts.ts";
import { rippleStatus } from "./router.ts";
import type { RouterClient } from "./router.ts";
import type { Sessions } from "./sessions.ts";

/** Stop writing to a client whose socket has this much queued; its pump resumes when it drains. */
const HIGH_WATER = 1024 * 1024;
/** A reconnecting client further behind than this many frames gets the tail instead of a replay. */
const CATCHUP_FRAMES = 4;
/** `/api/limits` makes the router read each provider's quota; once a minute is plenty for percentages. */
const LIMITS_MS = 60_000;
const BLOB_CHUNK_CHARS = 60_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
};

export const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const require = module.createRequire(import.meta.url);
/** Published path → file, for what the PWA loads from outside web/. The relay's build serves the same paths. */
export const SHARED: Record<string, (pkgDir: string) => string> = {
  "src/protocol.ts": (pkg) => path.join(pkg, "src", "protocol.ts"),
  "src/chunks.ts": (pkg) => path.join(pkg, "src", "chunks.ts"),
  "src/tool-details.ts": (pkg) => path.join(pkg, "src", "tool-details.ts"),
  "src/wrap-up.ts": (pkg) => path.join(pkg, "src", "wrap-up.ts"),
  "src/e2ee.ts": (pkg) => path.join(pkg, "src", "e2ee.ts"),
  "vendor/nacl-fast.min.js": () => require.resolve("tweetnacl/nacl-fast.min.js"),
};

export interface ServerOptions {
  listen: string;
  port: number;
  token: string;
  webDir: string;
  sessions: Sessions;
  /** `limits` and `modSettings` feed `HostInfo.ripple`; a router without them just leaves it out.
   * `setEffortAuto` is the one write a phone may ask for (`op: "effort_auto"`). */
  router: Pick<RouterClient, "models" | "status"> & Partial<Pick<RouterClient, "limits" | "modSettings" | "setEffortAuto">>;
  hostName: string;
  version: string;
  recentCli: () => Promise<RecentSource[]>;
  log?: (line: string) => void;
  push?: Pick<Notifier, "subscribe" | "unsubscribe"> & { publicKey: string };
  expoPush?: { subscribe(clientId: string, token: string, lang: "ko" | "en", platform?: "ios" | "android", key?: string): void; unsubscribe(clientId: string): void };
  local?: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> };
  pushDevices?: () => string[];
  clearPush?: () => void;
  now?: () => number;
}

/**
 * A phone connection: a `ws` socket on the direct path, or a decrypted channel through the relay
 * (relay.ts). Both carry the same JSON frames, so everything below is the same for either.
 */
export interface Peer {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message" | "close" | "error", fn: (data?: unknown) => void): unknown;
}

interface Client {
  ws: Peer;
  authed: boolean;
  /** the phone's own id from hello: one push subscription per device */
  clientId: string;
  /** last time this client said the app is visible; 0 once it said hidden */
  visibleAt: number;
  lastRx: number;
  /** session → log epoch and last seq sent to this client */
  attached: Map<string, { epoch: string; seq: number }>;
  pumping: Set<string>;
  pendingTail: Set<string>;
  retries: Map<string, ReturnType<typeof setTimeout>>;
  /** The session list waiting for a backed-up connection to drain. */
  sessionsRetry: ReturnType<typeof setTimeout> | null;
  features: ReturnType<typeof clientFeatures>;
}

export class HostServer {
  private opts: ServerOptions;
  private http: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private localHttp: http.Server | null = null;
  private refreshing = false;
  private handling = 0;

  /** Atomic on the host's event loop: no accepted command or queued turn can race this reservation. */
  prepareRefresh(): boolean {
    if (this.refreshing || this.handling || !this.opts.sessions.prepareRefresh()) return false;
    this.refreshing = true;
    return true;
  }
  private lastSeen = new Map<string, number>();

  phones(): Phone[] {
    const push = new Set(this.opts.pushDevices?.() ?? []);
    const phones = new Map<string, Phone>([...push].map(clientId => [clientId, { clientId, connected: false, lastSeen: this.lastSeen.get(clientId) ?? null, push: true }]));
    for (const c of this.clients) {
      if (!c.authed || !c.clientId || c.ws.readyState !== c.ws.OPEN) continue;
      const prior = phones.get(c.clientId);
      phones.set(c.clientId, { clientId: c.clientId, connected: true, lastSeen: Math.max(prior?.lastSeen ?? 0, c.lastRx), push: push.has(c.clientId) });
    }
    return [...phones.values()];
  }

  rotateToken(token: string): void {
    this.opts.token = token;
    for (const c of this.clients) {
      if (!c.authed) continue;
      c.authed = false;
      c.attached.clear();
      c.ws.terminate();
      this.clients.delete(c);
    }
    this.syncWatches();
    this.uploads.clear();
    this.seenAt.clear();
    this.lastSeen.clear();
    this.opts.clearPush?.();
  }
  private stripped = new Map<string, { mtime: number; body: string }>();
  private models: { at: number; data: ProviderGroup[] } | null = null;
  private uploads = new Map<string, { data: string; at: number }>();
  private hostInfo: HostInfo;
  private limitsBody: unknown = null;
  private limitsAt = -Infinity;
  private timers: ReturnType<typeof setInterval>[] = [];
  private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  /** session → last time a connected phone looked at it (attach, or visible presence while
   * attached). Push goes out only when nobody looked in the last SEEN_MS (Paseo's
   * agent-attention-policy PRESENCE_THRESHOLD_MS, 180 s). */
  private seenAt = new Map<string, number>();

  constructor(opts: ServerOptions) {
    this.opts = opts;
    const desktopProblem = opts.sessions.desktopProblem?.();
    const canWriteAuto = typeof opts.router.setEffortAuto === "function";
    this.hostInfo = { name: opts.hostName, version: opts.version, routerOk: true, queue: true,
      capabilities: { sessionFiles: true, folderFiles: true, diffScope: true, ...(canWriteAuto ? { effortAuto: true } : {}) },
      ...(desktopProblem ? { desktopProblem } : {}) };
    this.http = http.createServer((req, res) => this.serve(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_CAP });
    this.http.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/ws" || !this.sameOrigin(req)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws));
    });
  }

  /** A page on another origin in this machine's browser must not drive the socket, token or not. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  /** True while a connected phone reported the app visible within VISIBLE_MS: then nobody needs a push. */
  someoneLooking(): boolean {
    const now = this.now();
    for (const c of this.clients) if (c.authed && c.visibleAt > 0 && now - c.visibleAt < VISIBLE_MS && c.ws.readyState === c.ws.OPEN) return true;
    return false;
  }

  /** True while a connected phone looked at this session in the last SEEN_MS: then it needs no push. */
  sessionSeenRecently(session: string): boolean {
    return this.now() - (this.seenAt.get(session) ?? 0) < SEEN_MS;
  }

  private markSeen(c: Client, session: string): void {
    if (!c.authed || c.visibleAt <= 0 || this.now() - c.visibleAt >= VISIBLE_MS) return;
    this.seenAt.set(session, this.now());
    if (this.seenAt.size > 500) {
      const cutoff = this.now() - SEEN_MS;
      for (const [id, at] of this.seenAt) if (at < cutoff) this.seenAt.delete(id);
    }
  }

  private syncWatches(): void {
    const ids = new Set<string>();
    for (const c of this.clients) if (c.authed && c.ws.readyState === c.ws.OPEN) for (const id of c.attached.keys()) ids.add(id);
    this.opts.sessions.watchAttached(ids);
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private desktopTicks = 0;

  private pollDesktop(): void {
    // The desktop poll runs on its own timer even with no phone connected, so a Mac session that
    // finishes while nobody watches still appends its result — and the push for it goes out. Each
    // tick also asks Remote Control for every live Mac session's state over the network. Only
    // when no phone is looking AND none is attached may it slow to every fifth tick (15 s).
    // Hidden attached timelines still need the 3 s fallback when file notifications are lost.
    const attached = [...this.clients].some(c => c.authed && c.ws.readyState === c.ws.OPEN && c.attached.size > 0);
    if (!attached && !this.someoneLooking() && this.desktopTicks++ % 5 !== 0) return;
    void this.opts.sessions.pollDesktop().catch(error => {
      this.opts.log?.(`desktop poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.listen, () => {
        this.http.off("error", reject);
        this.timers.push(setInterval(() => this.reapStale(), PING_MS));
        this.timers.push(setInterval(() => void this.checkRouter(), 15_000));
        this.timers.push(setInterval(() => this.pollDesktop(), 3000));
        this.timers.push(setInterval(() => { if (!this.refreshing) this.opts.sessions.pollQueued(); }, 1000));
        void this.checkRouter();
        resolve();
      });
    });
    // A specific LAN/Tailscale/IPv6 bind does not receive 127.0.0.1 traffic. Keep its public
    // interface unchanged and add only a loopback control listener on the same port.
    if (this.opts.local && this.opts.listen !== "127.0.0.1" && this.opts.listen !== "localhost" && this.opts.listen !== "0.0.0.0" && this.opts.listen !== "::") {
      const local = http.createServer((req, res) => {
        try {
          const pathname = new URL(req.url ?? "/", "http://local").pathname;
          if (!pathname.startsWith("/local/")) { res.writeHead(404).end(); return; }
        } catch { res.writeHead(400).end(); return; }
        this.serve(req, res);
      });
      this.localHttp = local;
      try {
        await new Promise<void>((resolve, reject) => {
          local.once("error", reject);
          local.listen(this.address().port, "127.0.0.1", () => { local.off("error", reject); resolve(); });
        });
      } catch (error) { await this.close(); throw error; }
    }
  }

  close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = null;
    for (const c of this.clients) { c.attached.clear(); c.ws.terminate(); }
    this.syncWatches();
    return Promise.all([this.http, this.localHttp].filter((server): server is http.Server => server !== null)
      .map(server => new Promise<void>(resolve => server.close(() => resolve())))).then(() => {});
  }

  address(): { port: number } { return this.http.address() as { port: number }; }

  // ---- session events in, frames out ---------------------------------------------------------

  /** Called for every appended event: push it to every client attached to that session. */
  onEvent(session: string): void {
    const snapshot = this.opts.sessions.summaryOf(session)?.origin === "desktop";
    for (const c of this.clients) {
      if (!c.authed || !c.attached.has(session)) continue;
      if (snapshot) this.attach(c, session, undefined, undefined);
      else this.pump(c, session);
    }
  }

  /** Session list changed (state, pending count, a new one). Coalesced; lists are small but frequent. */
  onSessions(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      const msg = this.sessionList();
      if (!msg) return;
      for (const c of this.clients) if (c.authed) this.sendSessions(c, msg);
    }, 150);
  }

  private sessionList(): Extract<HostMsg, { t: "sessions" }> | null {
    try {
      return { t: "sessions", sessions: this.opts.sessions.list(), groups: this.opts.sessions.groups() };
    } catch (error) {
      this.opts.log?.(`session list failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** A backed-up connection gets the list once it drains, and then only the newest one: a list per
   * change would keep the buffer full and hold the conversation's own frames behind it. */
  private sendSessions(c: Client, msg: Extract<HostMsg, { t: "sessions" }>): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount >= HIGH_WATER) {
      c.sessionsRetry ??= setTimeout(() => {
        c.sessionsRetry = null;
        const latest = this.sessionList();
        if (latest) this.sendSessions(c, latest);
      }, 200);
    } else this.send(c, msg);
    // A rebase can replace the log without appending an event afterward.
    for (const [id, cursor] of c.attached) {
      const epoch = msg.sessions.find(session => session.id === id)?.epoch;
      if (epoch && epoch !== cursor.epoch) this.pump(c, id);
    }
  }

  private pump(c: Client, session: string): void {
    if (c.pumping.has(session)) return;
    c.pumping.add(session);
    try {
      if (c.ws.readyState !== c.ws.OPEN || !c.attached.has(session)) return;
      const log = this.opts.sessions.log(session);
      for (;;) {
        const cursor = c.attached.get(session);
        if (!cursor) break;
        if (c.pendingTail.has(session) || cursor.epoch !== log.epoch) { this.sendTail(c, session, log); break; }
        if (cursor.seq >= log.lastSeq) break;
        if (c.ws.bufferedAmount >= HIGH_WATER) { this.retryPump(c, session); break; }
        const page = log.readAfter(cursor.seq);
        // Skipped (superseded) deltas can leave a page empty; the cursor still moves to the end.
        const last = page.events.length ? page.events[page.events.length - 1]!.seq : log.lastSeq;
        c.attached.set(session, { epoch: log.epoch, seq: page.more ? last : Math.max(last, log.lastSeq) });
        if (page.events.length) this.send(c, { t: "events", session, epoch: log.epoch, events: page.events, more: page.more });
        if (!page.more) break;
      }
    } finally {
      c.pumping.delete(session);
    }
  }

  private attach(c: Client, session: string, epoch: string | undefined, afterSeq: number | undefined): void {
    if (!this.opts.sessions.has(session)) { this.send(c, { t: "error", code: "no_session", message: "no such session", session }); return; }
    this.markSeen(c, session);
    // A Mac session may already have approvals waiting from before this attach (or before the
    // host's Remote Control stream connected): fetch them so no approval card is missed.
    void this.opts.sessions.syncBridge(session).catch(error => {
      this.opts.log?.(`bridge sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const log = this.opts.sessions.log(session);
    c.attached.set(session, c.attached.get(session) ?? { epoch: log.epoch, seq: 0 });
    this.syncWatches();
    if (epoch === log.epoch && afterSeq !== undefined && afterSeq > 0 && afterSeq <= log.lastSeq) {
      // Resume by seq, unless the gap is so large that replaying it would be slower than starting from the tail.
      let cursor = afterSeq;
      let frames = 0;
      for (; frames < CATCHUP_FRAMES; frames++) {
        const page = log.readAfter(cursor);
        if (!page.more) break;
        cursor = page.events.length ? page.events[page.events.length - 1]!.seq : log.lastSeq;
      }
      if (frames < CATCHUP_FRAMES) {
        c.attached.set(session, { epoch: log.epoch, seq: afterSeq });
        // Already up to date: say so, or a reader showing its own saved copy cannot tell that the
        // copy is the computer's current one until something new happens.
        if (afterSeq === log.lastSeq) this.send(c, { t: "events", session, epoch: log.epoch, events: [], more: false });
        this.pump(c, session);
        return;
      }
    }
    this.sendTail(c, session, log);
  }

  private retryPump(c: Client, session: string): void {
    if (c.retries.has(session)) return;
    c.retries.set(session, setTimeout(() => {
      c.retries.delete(session);
      this.pump(c, session);
    }, 200));
  }

  private sendTail(c: Client, session: string, log: ReturnType<Sessions["log"]>): void {
    if (c.ws.readyState !== c.ws.OPEN || !c.attached.has(session)) return;
    if (c.ws.bufferedAmount >= HIGH_WATER) {
      c.pendingTail.add(session);
      this.retryPump(c, session);
      return;
    }
    c.pendingTail.delete(session);
    const tail = log.tail();
    c.attached.set(session, { epoch: log.epoch, seq: log.lastSeq });
    this.send(c, { t: "events", session, epoch: log.epoch, events: tail.events, more: false, tail: { hasOlder: tail.hasOlder } });
  }

  // ---- sockets --------------------------------------------------------------------------------

  /** A phone connected, directly or through the relay; it must say hello with the token within 10 s. */
  connected(ws: Peer): void {
    const c: Client = { ws, authed: false, clientId: "", visibleAt: 0, lastRx: Date.now(), attached: new Map(), pumping: new Set(), pendingTail: new Set(), retries: new Map(), sessionsRetry: null, features: new Set() };
    this.clients.add(c);
    const helloTimer = setTimeout(() => { if (!c.authed) ws.close(4001, "hello"); }, 10_000);
    ws.on("message", (data) => {
      c.lastRx = Date.now();
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)) as ClientMsg; } catch { return; }
      this.handling++;
      void this.onClient(c, msg).catch((e: Error) => this.send(c, { t: "error", code: "internal", message: e.message }))
        .finally(() => { this.handling--; });
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      for (const timer of c.retries.values()) clearTimeout(timer);
      c.retries.clear();
      c.pendingTail.clear();
      if (c.sessionsRetry) clearTimeout(c.sessionsRetry);
      c.sessionsRetry = null;
      if (c.authed && c.clientId) this.lastSeen.set(c.clientId, c.lastRx);
      this.clients.delete(c);
      this.syncWatches();
    });
    ws.on("error", () => { /* close follows */ });
  }

  private reapStale(): void {
    const now = Date.now();
    for (const c of this.clients) if (now - c.lastRx > STALE_MS) c.ws.terminate();
  }

  private send(c: Client, msg: HostMsg): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (msg.t === "events" || msg.t === "history") msg = { ...msg, events: msg.events.map(event => clientEvent(event, c.features)) };
    const text = JSON.stringify(msg);
    const bytes = Buffer.byteLength(text);
    if (bytes > FRAME_CAP) {
      // A client that asked for chunkedFrames gets the same frame in slices of its exact bytes, so
      // a big queue, edit answer or session list arrives whole; everyone else keeps the old wire.
      // Past CHUNK_MESSAGE_MAX the message is not chunked at all: the phone's memory stays bounded.
      if (c.features.has("chunkedFrames") && bytes <= CHUNK_MESSAGE_MAX) {
        for (const chunk of chunkFrames(text, randomUUID())) {
          if (c.ws.readyState !== c.ws.OPEN) return;
          c.ws.send(JSON.stringify(chunk));
        }
        return;
      }
      // The log caps events and pages, so this means a bug; say so rather than kill the socket (Paseo #2610).
      this.opts.log?.(`frame over cap dropped: ${msg.t} ${bytes} bytes`);
      if (msg.t !== "error") this.send(c, { t: "error", code: "too_large", message: `${msg.t} frame over ${FRAME_CAP} bytes` });
      return;
    }
    c.ws.send(text);
  }

  private async onClient(c: Client, msg: ClientMsg): Promise<void> {
    if (msg.t === "ping") { this.send(c, { t: "pong", n: msg.n }); return; }
    if (!c.authed) {
      if (msg.t === "hello" && tokenMatches(this.opts.token, msg.token)) {
        const clientId = typeof msg.clientId === "string" ? msg.clientId : "";
        if (clientId && !/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) {
          this.send(c, { t: "denied", reason: "token" });
          c.ws.close(4003, "denied");
          return;
        }
        c.authed = true;
        c.clientId = clientId;
        c.features = clientFeatures(msg.features);
        this.send(c, { t: "ready", host: this.hostInfo, sessions: this.opts.sessions.list(), groups: this.opts.sessions.groups() });
      } else {
        this.send(c, { t: "denied", reason: "token" });
        c.ws.close(4003, "denied");
      }
      return;
    }
    if (this.refreshing) {
      if ("reqId" in msg && msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: "호스트 업데이트 중입니다. 잠시 후 다시 시도해 주세요." });
      else this.send(c, { t: "error", code: "host_updating", message: "호스트 업데이트 중입니다. 잠시 후 다시 시도해 주세요.", ...("clientMsgId" in msg ? { clientMsgId: msg.clientMsgId } : {}) });
      return;
    }
    const s = this.opts.sessions;
    switch (msg.t) {
      case "hello": return;
      case "attach": this.attach(c, msg.session, msg.epoch, msg.afterSeq); return;
      case "detach": {
        c.attached.delete(msg.session);
        c.pendingTail.delete(msg.session);
        const retry = c.retries.get(msg.session);
        if (retry) clearTimeout(retry);
        c.retries.delete(msg.session);
        this.syncWatches();
        return;
      }
      case "seen":
        if (c.attached.has(msg.session) && c.visibleAt > 0 && this.now() - c.visibleAt < VISIBLE_MS && s.has(msg.session)) s.markSeen(msg.session);
        return;
      case "archive":
        try { s.setArchived(msg.session, msg.archived === true); }
        catch (e) { this.send(c, { t: "error", code: "archive", message: (e as Error).message, session: msg.session }); }
        return;
      case "unread":
        try { s.markUnread(msg.session); }
        catch (e) { this.send(c, { t: "error", code: "unread", message: (e as Error).message, session: msg.session }); }
        return;
      case "history": {
        if (!s.has(msg.session)) return;
        const log = s.log(msg.session);
        const mismatch = msg.epoch !== undefined && msg.epoch !== log.epoch;
        const page = mismatch ? { events: [], hasOlder: false } : log.before(msg.beforeSeq);
        this.send(c, { t: "history", session: msg.session, reqId: msg.reqId, epoch: log.epoch, events: page.events, hasOlder: page.hasOlder });
        // Reading can rebuild a desktop snapshot before its watcher notices. Notify every reader,
        // even when the requester is an older client that did not send an epoch.
        const requesterCursor = c.attached.get(msg.session);
        for (const peer of this.clients) {
          const cursor = peer.attached.get(msg.session);
          if (peer.authed && cursor && cursor.epoch !== log.epoch) this.pump(peer, msg.session);
        }
        if (mismatch && !requesterCursor) this.attach(c, msg.session, undefined, undefined);
        else if (mismatch && requesterCursor?.epoch === log.epoch) this.sendTail(c, msg.session, log);
        return;
      }
      case "create":
        try {
          const id = await s.create(msg);
          this.send(c, { t: "ack", clientMsgId: msg.clientMsgId, session: id });
        } catch (e) {
          if (e instanceof OutcomeUnknownError) {
            this.send(c, { t: "error", code: "outcome_unknown", message: e.message, clientMsgId: msg.clientMsgId });
          } else {
            this.send(c, { t: "error", code: "create", message: (e as Error).message, clientMsgId: msg.clientMsgId });
          }
        }
        return;
      case "send": {
        try {
          const desktop = s.list().some(session => session.id === msg.session && session.origin === "desktop");
          const id = await s.orderedSend(msg.session, msg.clientMsgId, msg.text, msg.attachments, msg.behavior);
          // A message the person sends after a Stop is them carrying on: the queue goes on after it.
          s.resumeQueue(msg.session);
          this.send(c, { t: "ack", clientMsgId: msg.clientMsgId, session: id });
          if (desktop && id === msg.session) this.attach(c, id, undefined, undefined);
        } catch (e) {
          if (e instanceof OutcomeUnknownError) {
            this.send(c, { t: "error", code: "outcome_unknown", message: e.message, clientMsgId: msg.clientMsgId, session: msg.session });
          } else {
            this.send(c, { t: "error", code: "send", message: (e as Error).message, clientMsgId: msg.clientMsgId, session: msg.session });
          }
        }
        return;
      }
      case "decide":
        try {
          if (msg.decision !== "allow" && msg.decision !== "allow_always" && msg.decision !== "deny") throw new Error("invalid decision");
          if (msg.decision === "allow_always" && !c.features.has("scopedAlways")) throw new Error("허용 범위를 확인하려면 앱을 업데이트해 주세요. 이번 요청만 허용할 수 있습니다.");
          if (!await s.decide(msg.session, msg.id, msg.decision, msg.message, msg.answers, msg.reqId)) throw new Error("이미 처리됨");
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: true, data: null });
        } catch (e) {
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
          else this.send(c, { t: "error", code: "permission", message: (e as Error).message, session: msg.session });
        }
        return;
      case "set_mode":
        try {
          const data = await s.setMode(msg.sessionId, msg.mode, msg.reqId);
          this.send(c, settingsResponse(msg.reqId, data, c.features));
        } catch (e) {
          this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
        }
        return;
      case "interrupt":
      case "set_model":
        try {
          // Stop from the phone also pauses what it queued: the person decides what goes next.
          let data = null;
          if (msg.t === "interrupt") { s.holdQueue(msg.session); await s.interrupt(msg.session); }
          else data = await s.setModel(msg.session, msg.model, msg.effort, msg.reqId);
          if (msg.reqId) this.send(c, data ? settingsResponse(msg.reqId, data, c.features) : { t: "res", reqId: msg.reqId, ok: true, data });
          else if (data && data.status !== "applied" && !c.features.has("settingsResult")) {
            const response = settingsResponse("", data, c.features);
            if (response.t === "res" && !response.ok) this.send(c, { t: "error", code: msg.t, session: msg.session, message: response.error });
          }
        } catch (e) {
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
          else this.send(c, { t: "error", code: msg.t, session: msg.session, message: (e as Error).message });
        }
        return;
      case "presence": c.visibleAt = msg.visible === true ? this.now() : 0; if (msg.visible === true) for (const session of c.attached.keys()) this.markSeen(c, session); return;
      case "req":
        try {
          this.send(c, { t: "res", reqId: msg.reqId, ok: true, data: await this.request(msg.op, c) });
        } catch (e) {
          this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
        }
        return;
    }
  }

  private async request(op: ReqOp, c: Client): Promise<unknown> {
    const s = this.opts.sessions;
    switch (op.op) {
      case "upload": {
        if (!s.has(op.session) || !/^[\w-]{1,100}$/.test(op.uploadId) || typeof op.data !== "string" || op.data.length > BLOB_CHUNK_CHARS || /[^A-Za-z0-9+/=]/.test(op.data)) throw new Error("Invalid attachment chunk.");
        for (const [key, value] of this.uploads) if (this.now() - value.at > 300_000) this.uploads.delete(key);
        const key = `${c.clientId}/${op.session}/${op.uploadId}`;
        if (!this.uploads.has(key) && this.uploads.size >= 16) throw new Error("Too many unfinished uploads. Try again later.");
        const previous = op.offset === 0 ? "" : this.uploads.get(key)?.data;
        if (previous === undefined || previous.length !== op.offset) throw new Error("Upload offset mismatch. Retry the attachment.");
        const data = previous + op.data;
        if (data.length > Math.ceil(ATTACHMENT_CAP / 3) * 4) { this.uploads.delete(key); throw new Error("Attachment exceeds 8 MB."); }
        if (!op.done) { this.uploads.set(key, { data, at: this.now() }); return null; }
        this.uploads.delete(key);
        // Every chunk already passed the alphabet check. Scan for padding once, without a
        // repeated regex group (which overflows V8's stack on ordinary multi-MB uploads).
        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        const paddingAt = data.indexOf("=");
        const bytes = data.length / 4 * 3 - padding;
        if (!data || data.length % 4 !== 0 || (paddingAt !== -1 && paddingAt !== data.length - padding) || bytes > ATTACHMENT_CAP) throw new Error("Invalid attachment bytes.");
        return { blob: s.log(op.session).image(data) };
      }
      case "models": {
        if (!this.models || Date.now() - this.models.at > 30_000) this.models = { at: Date.now(), data: await this.opts.router.models() };
        return this.models.data;
      }
      /** The Mac mod's host-wide setting, not a session's effort: it reaches the mod by its own
       * poll, and the phones hear the stored value at once through a fresh `ripple` read. */
      case "effort_auto": {
        const write = this.opts.router.setEffortAuto;
        if (typeof write !== "function") throw new Error("this host cannot change the Auto setting");
        if (typeof op.on !== "boolean") throw new Error("Invalid Auto setting.");
        const effortAuto = await write.call(this.opts.router, op.on);
        await this.checkRouter();
        return { effortAuto };
      }
      case "folders": {
        const cli = await this.opts.recentCli().catch(() => []);
        return recentFolders([...s.recentSources(), ...cli]);
      }
      case "browse": return browse(op.path, op.hidden ?? false);
      case "mkdir": return { path: await makeFolder(op.parent, op.name) };
      case "git": return macConsent(op.path, () => gitInfo(op.path));
      case "commands": return s.commands(op.session);
      /** Read-only, and only below the folder the session itself works in. The path from the phone
       * is resolved against that folder and must stay there after symlinks are resolved too. */
      case "folder_list": {
        const summary = s.summaryOf(op.session);
        if (!summary) throw new Error("no such session");
        if (op.path !== undefined && (typeof op.path !== "string" || op.path.length > 512)) throw new Error("Invalid folder path.");
        return macConsent(summary.cwd, () => listSessionFolder(summary.cwd, op.path), { wait: 2500 });
      }
      case "folder_file": {
        const summary = s.summaryOf(op.session);
        if (!summary) throw new Error("no such session");
        if (typeof op.path !== "string" || !op.path || op.path.length > 512) throw new Error("Invalid folder path.");
        return macConsent(summary.cwd, () => readSessionFolderFile(summary.cwd, op.path), { wait: 2500 });
      }
      case "enqueue": await s.enqueue(op.session, op.clientMsgId, op.text, op.attachments ?? []); return { queued: true };
      case "queue_remove": return s.removeQueued(op.session, op.id);
      case "queue_send": return { session: await s.sendQueued(op.session, op.id) };
      case "queue_resume": s.resumeQueue(op.session); return null;
      case "blob": {
        if (!s.has(op.session)) throw new Error("no such session");
        const text = s.blob(op.session, op.id);
        if (text === null) throw new Error("no such blob");
        const offset = op.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("Invalid blob offset.");
        const end = Math.min(text.length, offset + BLOB_CHUNK_CHARS);
        const chunk: BlobChunk = { text: text.slice(offset, end), offset, next: end < text.length ? end : null, bytes: Buffer.byteLength(text) };
        return chunk;
      }
      case "sub": {
        const log = s.subLog(op.session, op.sub);
        if (!log) throw new Error("no such subagent");
        const page = log.readAfter(op.afterSeq ?? 0);
        return { ...page, events: page.events.map(event => clientEvent(event, c.features)) };
      }
      /** The folder comes from the session (its record's cwd; a Claude app session's summary),
       * never from the phone, so one connection can only ever read sessions it can already see. */
      case "diff": {
        const summary = s.summaryOf(op.session);
        if (!summary) throw new Error("no such session");
        return diffView(summary.cwd, { scope: diffScope(op.scope) });
      }
      case "expo_push_subscribe":
        if (!this.opts.expoPush) throw new Error("native push is off on this host");
        if (!c.clientId) throw new Error("no device id");
        this.opts.expoPush.subscribe(c.clientId, op.token, op.lang, op.platform, op.key);
        return { ok: true };
      case "expo_push_unsubscribe":
        if (c.clientId) this.opts.expoPush?.unsubscribe(c.clientId);
        return { ok: true };
      case "push_key":
        if (!this.opts.push) throw new Error("push is off on this host");
        return { publicKey: this.opts.push.publicKey };
      case "push_subscribe":
        if (!this.opts.push) throw new Error("push is off on this host");
        if (!c.clientId) throw new Error("no device id");
        this.opts.push.subscribe(c.clientId, op.subscription, op.lang);
        return { ok: true };
      case "push_unsubscribe":
        if (c.clientId) this.opts.push?.unsubscribe(c.clientId);
        return { ok: true };
    }
  }

  private async checkRouter(): Promise<void> {
    const st = await this.opts.router.status();
    const next: HostInfo = { ...this.hostInfo, routerOk: st.ok, ...(st.problem ? { routerProblem: st.problem } : {}) };
    if (!st.problem) delete next.routerProblem;
    const ripple = st.ok ? await this.readRipple() : undefined;
    if (ripple) next.ripple = ripple; else delete next.ripple;
    // `at` moves on every read; only a change a phone could see is worth a message.
    const shown = (r: RippleStatus | undefined): string => JSON.stringify(r && { ...r, at: 0 });
    if (next.routerOk === this.hostInfo.routerOk && next.routerProblem === this.hostInfo.routerProblem && shown(next.ripple) === shown(this.hostInfo.ripple)) return;
    this.setHostInfo(next);
  }

  /**
   * The mod's mode and effort range every check, the provider limits at most once a minute (the
   * router asks each provider's own API for them). A failed limits read keeps the last good body;
   * without mod settings there is nothing to say and `ripple` is left out.
   */
  private async readRipple(): Promise<RippleStatus | undefined> {
    const { limits, modSettings } = this.opts.router;
    if (!limits || !modSettings) return undefined;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.limitsAt >= LIMITS_MS) {
      this.limitsAt = now;
      try { this.limitsBody = await limits.call(this.opts.router); } catch { /* keep the last good body */ }
    }
    try { return rippleStatus(this.limitsBody, await modSettings.call(this.opts.router), now); } catch { return undefined; }
  }

  /** Sessions says Claude app sessions became unreachable (the Mac's login) or reachable again. */
  setDesktopProblem(problem: string | null): void {
    if ((problem ?? undefined) === this.hostInfo.desktopProblem) return;
    const next: HostInfo = { ...this.hostInfo, ...(problem ? { desktopProblem: problem } : {}) };
    if (!problem) delete next.desktopProblem;
    this.setHostInfo(next);
  }

  private setHostInfo(next: HostInfo): void {
    this.hostInfo = next;
    for (const c of this.clients) if (c.authed) this.send(c, { t: "host", host: next });
  }

  // ---- the PWA --------------------------------------------------------------------------------

  /** Never throws: a malformed path is a 400, anything else unexpected a logged 500. */
  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.serveInner(req, res);
    } catch (error) {
      this.opts.log?.(`http serve failed: ${error instanceof Error ? error.message : String(error)}`);
      try { res.writeHead(500).end(); } catch { /* the socket is already gone */ }
    }
  }

  private serveInner(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/local/")) {
      if (!this.opts.local) { res.writeHead(404).end(); return; }
      void this.opts.local.handle(req, res).catch(() => {
        // Never log a local request, body or exception: pairing responses contain credentials.
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
      return;
    }
    if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let rel: string;
    try {
      rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch { res.writeHead(400).end(); return; }
    if (rel.includes("\0")) { res.writeHead(400).end(); return; }
    // Files from outside web/ the client loads: the shared protocol and encryption, and tweetnacl.
    const shared = SHARED[rel];
    const file = shared ? shared(path.dirname(this.opts.webDir)) : path.resolve(this.opts.webDir, rel);
    const ext = path.extname(file);
    if ((!shared && !file.startsWith(this.opts.webDir + path.sep)) || !TYPES[ext]) { res.writeHead(404).end(); return; }
    let stat: fs.Stats;
    try { stat = fs.statSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      res.writeHead(404).end();
      return;
    }
    let body: string | Buffer;
    if (ext === ".ts") {
      const hit = this.stripped.get(file);
      if (hit && hit.mtime === stat.mtimeMs) body = hit.body;
      else {
        // The client is TypeScript like the rest of the product; Node strips the types, no build step.
        body = module.stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "strip" });
        this.stripped.set(file, { mtime: stat.mtimeMs, body });
      }
    } else body = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": TYPES[ext]!,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(ext === ".html" ? { "content-security-policy": CSP } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }
}
