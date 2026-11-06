// One host's room on the relay: the host's control socket, and one pair of sockets per phone
// connection (the phone's, and the host's data socket for it). The room forwards frames between a
// pair untouched — they are end-to-end encrypted (src/e2ee.ts) — and never stores one.
//
// Pure logic over a small context, so it runs the same inside the Durable Object (worker.ts, where
// the context is the hibernation API: tags survive the object sleeping between frames) and in an
// in-process test with fake sockets.
import { EXPO_TOKEN_RE, HOST_SILENT_MS, RELAY_CLOSE, RELAY_FRAME_CAP, WATCH_ALARM_MS, WATCH_TOKENS_MAX, WATCH_TTL_S, outageBody } from "../src/protocol.ts";
import type { HostControlMsg, RelayMsg } from "../src/protocol.ts";

export interface Sock {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RoomCtx<S extends Sock> {
  accept(ws: S, tags: string[]): void;
  /**
   * Accepted sockets with this tag. On Cloudflare this includes a socket the room closed whose
   * other end never answered the close (a host that vanished without a FIN): it stays listed, in
   * acceptance order, until TCP gives up — measured 8+ minutes on the deployed relay (2026-10-15).
   */
  sockets(tag: string): S[];
  tags(ws: S): string[];
  /** When the runtime last answered this socket's "ping" (auto-response), in ms; null if never. */
  lastPing(ws: S): number | null;
  now(): number;
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  /** The Durable Object's one-shot alarm (survives hibernation and eviction). */
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  /** POST these Expo messages; the only network call the room makes. */
  postExpo(messages: OutagePush[]): Promise<void>;
  newId(): string;
  sha256(text: string): Promise<string>;
}

/** One Expo message the room builds itself (no host text): fixed title and copy, no session. */
export interface OutagePush {
  to: string;
  title: "Ripple Remote";
  body: string;
  data: { session: ""; host: string };
  sound: "default";
  ttl: number;
}

/** What a `watch` frame leaves in the room's storage; `firedAt` once the alarm alerted the phone. */
export interface WatchState {
  tokens: { token: string; lang: "ko" | "en" }[];
  host: string;
  firedAt?: number;
}

const WATCH_KEY = "watch";

const say = (ws: Sock, msg: RelayMsg): void => { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } };
const shut = (ws: Sock, code: number, reason: string): void => { try { ws.close(code, reason); } catch { /* already closed */ } };

export const CONN_RE = /^[\w-]{8,64}$/;

export function frameBytes(data: string | ArrayBuffer | Uint8Array): number {
  return typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength;
}

export class Room<S extends Sock> {
  private ctx: RoomCtx<S>;
  /** Pings that reached the room itself (the runtime normally answers them unseen); in memory only. */
  private pinged = new WeakMap<S, number>();
  constructor(ctx: RoomCtx<S>) { this.ctx = ctx; }

  /**
   * The first host to connect registers this server id with its secret (stored as a hash); later
   * ones must match. Someone who knows the id but not the secret cannot take the room over.
   */
  async hostAllowed(secret: string | null): Promise<boolean> {
    if (!secret || secret.length < 32) return false;
    const hash = await this.ctx.sha256(secret);
    const known = await this.ctx.get("secret");
    if (known === undefined) { await this.ctx.put("secret", hash); return true; }
    return known === hash;
  }

  /**
   * The host's control socket. A newer one replaces an older (a host that reconnected before the
   * old socket timed out). It is tagged with when it was accepted, because a replaced socket can
   * stay listed long after its close (see RoomCtx.sockets) and must never be routed to again.
   */
  hostControl(ws: S, firedAt?: number): void {
    const old = this.ctx.sockets("host");
    // Strictly increasing even within one millisecond, so "newest" is never a tie.
    const at = Math.max(this.ctx.now(), ...old.map((o) => this.acceptedAt(o) + 1));
    this.ctx.accept(ws, ["host", `at:${at}`]);
    for (const o of old) shut(o, RELAY_CLOSE.replaced, "replaced");
    say(ws, { relay: "hello" });
    // A dead-man alert fired while this host was away: say so right after the hello (a separate
    // frame, so the hello keeps its shape for hosts that predate the switch). The host sends the
    // recovery notice and answers {"t":"cleared"}; the caller read this before accepting the socket.
    if (typeof firedAt === "number" && Number.isFinite(firedAt)) say(ws, { relay: "fired", firedAt });
    // Phones that arrived while the host was away and still have no data socket.
    for (const c of this.ctx.sockets("client")) {
      const conn = this.connOf(c, "c:");
      if (conn && !this.ctx.sockets(`d:${conn}`).length) say(ws, { relay: "connect", conn });
    }
  }

  /** The moment the dead-man switch alerted the phone for the current watch, if it did. */
  async alertedAt(): Promise<number | undefined> {
    return (await this.loadWatch())?.firedAt;
  }

  /**
   * The one host socket a phone may be sent to: the newest, and only while it is alive — it pinged
   * (or was accepted) within HOST_SILENT_MS. A silent newest socket is closed (a live host that
   * reads the close reconnects at once; a vanished one costs nothing) and the phone hears "host
   * offline" instead of waiting on a socket nobody reads.
   */
  private host(): S | null {
    let newest: S | null = null;
    let newestAt = -1;
    for (const h of this.ctx.sockets("host")) {
      const at = this.acceptedAt(h);
      if (at > newestAt) { newest = h; newestAt = at; }
    }
    if (!newest) return null;
    const heard = Math.max(newestAt, this.ctx.lastPing(newest) ?? 0, this.pinged.get(newest) ?? 0);
    if (this.ctx.now() - heard > HOST_SILENT_MS) { shut(newest, RELAY_CLOSE.stale, "no ping"); return null; }
    return newest;
  }

  /** A phone. It waits for {"relay":"open"} before its handshake; with no live host it is told so at once. */
  client(ws: S): void {
    const conn = this.ctx.newId();
    this.ctx.accept(ws, ["client", `c:${conn}`]);
    const host = this.host();
    if (!host) { shut(ws, RELAY_CLOSE.hostOffline, "host offline"); return; }
    say(host, { relay: "connect", conn });
  }

  /** Whether a host data socket for this connection can be accepted (the phone is still there). */
  hasClient(conn: string): boolean {
    return CONN_RE.test(conn) && this.ctx.sockets(`c:${conn}`).length > 0;
  }

  hostData(ws: S, conn: string): void {
    const old = this.ctx.sockets(`d:${conn}`);
    const at = Math.max(this.ctx.now(), ...old.map(o => this.acceptedAt(o) + 1));
    this.ctx.accept(ws, ["data", `d:${conn}`, `at:${at}`]);
    for (const o of old) shut(o, RELAY_CLOSE.replaced, "replaced");
    const phone = this.ctx.sockets(`c:${conn}`)[0];
    if (!phone) { shut(ws, RELAY_CLOSE.peerGone, "phone gone"); return; }
    // `liveness` tells the phone this relay answers its plain "ping" itself; older relays leave it
    // out and an older phone ignores it (it only reads `relay`).
    say(phone, { relay: "open", liveness: true });
  }

  async message(ws: S, data: string | ArrayBuffer): Promise<void> {
    if (frameBytes(data) > RELAY_FRAME_CAP) { shut(ws, RELAY_CLOSE.tooBig, "frame over cap"); return; }
    const tags = this.ctx.tags(ws);
    // Liveness never crosses the room. The runtime answers a plain "ping" itself without waking the
    // object; when the object is awake, this answers it in the runtime's place. A "pong" is the
    // runtime's answer on its way back and stops here too. Forwarding either would break the other
    // end: the encrypted pair only accepts sealed bytes.
    if (typeof data === "string" && (data === "ping" || data === "pong")) {
      if (data === "ping") {
        if (tags.includes("host")) this.pinged.set(ws, this.ctx.now());
        try { ws.send("pong"); } catch { /* closing */ }
      }
      return;
    }
    if (tags.includes("host")) {
      // Only the room's current host may change the watch: a replaced socket can outlive its close
      // (see RoomCtx.sockets) and must not keep an alarm alive for a host that is gone.
      if (this.newestHostIs(ws)) await this.control(ws, data);
      return;
    }
    const phone = this.connOf(ws, "c:");
    if (phone) { for (const d of this.ctx.sockets(`d:${phone}`)) d.send(data); return; }
    const host = this.connOf(ws, "d:");
    if (host) for (const c of this.ctx.sockets(`c:${host}`)) c.send(data);
  }

  /**
   * A host control frame. Only the authenticated control socket is tagged "host" (the secret was
   * checked before this socket was accepted), so a phone that sends one here changes nothing: a
   * phone's string frames are sealed data on its own socket, never this path.
   */
  private async control(ws: S, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg: Partial<HostControlMsg> & { tokens?: unknown; host?: unknown };
    try { msg = JSON.parse(data) as typeof msg; } catch { return; }
    if (msg?.t === "watch") await this.watch(ws, msg.tokens, msg.host);
    else if (msg?.t === "unwatch") await this.unwatch(ws);
    else if (msg?.t === "cleared" && typeof msg.firedAt === "number" && Number.isFinite(msg.firedAt)) await this.clearFired(msg.firedAt);
  }

  /**
   * Arm the dead-man switch: the room alerts the phones' Expo tokens if no renewal comes within
   * WATCH_ALARM_MS. Invalid tokens are dropped, at most WATCH_TOKENS_MAX kept; with none left there
   * is nothing to tell, so the watch is taken away instead.
   */
  private async watch(ws: S, rawTokens: unknown, rawHost: unknown): Promise<void> {
    const tokens: WatchState["tokens"] = [];
    if (Array.isArray(rawTokens)) {
      for (const raw of rawTokens) {
        if (tokens.length >= WATCH_TOKENS_MAX) break;
        const entry = raw as { token?: unknown; lang?: unknown } | null;
        const token = typeof entry?.token === "string" ? entry.token : "";
        if (!EXPO_TOKEN_RE.test(token)) continue;
        tokens.push({ token, lang: entry?.lang === "en" ? "en" : "ko" });
      }
    }
    if (!tokens.length) { await this.unwatch(ws); return; }
    const host = typeof rawHost === "string" && /^[\w-]{1,128}$/.test(rawHost) ? rawHost : "";
    const current = await this.loadWatch();
    // An outage already reported stays reported until the host acknowledges it.
    const firedAt = current?.firedAt;
    await this.ctx.put(WATCH_KEY, JSON.stringify({ tokens, host, ...(firedAt ? { firedAt } : {}) } satisfies WatchState));
    if (firedAt) {
      // This socket lived through the outage (the computer slept on the same WebSocket): the renewal
      // is the first it hears of it. Tell it now — the host sends the recovery notice once per
      // firedAt and answers `cleared` — and keep an alarm so renewals still count as liveness.
      say(ws, { relay: "fired", firedAt });
    }
    await this.ctx.setAlarm(this.ctx.now() + WATCH_ALARM_MS);
  }

  /**
   * Work has been idle long enough: no alarm, and no tokens kept. An outage already reported is
   * announced on this socket and kept until the host's `cleared` — an idle computer that slept
   * through the alarm and woke on the same WebSocket sends `unwatch` before it ever renews, so
   * this frame is the only chance to ask for the recovery notice. Keeping `firedAt` with no alarm
   * and no tokens means no new outage can be pushed while unwatched; the clear is still accepted.
   */
  private async unwatch(ws: S): Promise<void> {
    const firedAt = (await this.loadWatch())?.firedAt;
    await this.ctx.put(WATCH_KEY, JSON.stringify({ tokens: [], host: "", ...(firedAt ? { firedAt } : {}) } satisfies WatchState));
    await this.ctx.deleteAlarm();
    if (firedAt) say(ws, { relay: "fired", firedAt });
  }

  /** The host says it sent the recovery notice for this outage; the room stops re-announcing it. */
  private async clearFired(firedAt: number): Promise<void> {
    const current = await this.loadWatch();
    if (!current?.firedAt || current.firedAt !== firedAt) return;
    const next: WatchState = { tokens: current.tokens, host: current.host };
    await this.ctx.put(WATCH_KEY, JSON.stringify(next));
    // The host is back with a watch it did not drop: arm again here as well as on its next renewal.
    // (The clear and that renewal can arrive together; either message may run first.)
    if (next.tokens.length) await this.ctx.setAlarm(this.ctx.now() + WATCH_ALARM_MS);
  }

  /**
   * The Durable Object's alarm: no renewal since it was set, so the host is offline (or asleep)
   * while it had work. Send Expo exactly one batch — fixed copy built here from each token's lang,
   * no session, no host text — and record `firedAt` so a retried alarm never alerts twice.
   */
  async alarm(): Promise<void> {
    const current = await this.loadWatch();
    if (!current || current.firedAt || !current.tokens.length) return;
    const firedAt = this.ctx.now();
    await this.ctx.put(WATCH_KEY, JSON.stringify({ ...current, firedAt } satisfies WatchState));
    const messages: OutagePush[] = current.tokens.map((t) => ({
      to: t.token,
      title: "Ripple Remote",
      body: outageBody("disconnected", t.lang),
      data: { session: "", host: current.host },
      sound: "default",
      ttl: WATCH_TTL_S,
    }));
    try { await this.ctx.postExpo(messages); } catch { /* one attempt per outage; firedAt already records it */ }
  }

  private async loadWatch(): Promise<WatchState | null> {
    const raw = await this.ctx.get(WATCH_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw) as WatchState; } catch { return null; }
  }

  /** One side of a pair went away: the other has nothing to talk to, so it closes too and reconnects. */
  closed(ws: S): void {
    const phone = this.connOf(ws, "c:");
    if (phone) for (const d of this.ctx.sockets(`d:${phone}`)) if (d !== ws) shut(d, 1000, "phone left");
    const host = this.connOf(ws, "d:");
    // A replaced socket can close long after its successor was accepted, even after hibernation.
    if (host && !this.ctx.sockets(`d:${host}`).some(d => d !== ws && this.acceptedAt(d) > this.acceptedAt(ws))) {
      for (const c of this.ctx.sockets(`c:${host}`)) shut(c, RELAY_CLOSE.peerGone, "host left");
    }
  }

  /** 0 for a host socket accepted before sockets carried the tag (older than any tagged one). */
  private acceptedAt(ws: S): number {
    const tag = this.ctx.tags(ws).find((t) => t.startsWith("at:"));
    const at = tag ? Number(tag.slice(3)) : 0;
    return Number.isFinite(at) ? at : 0;
  }

  /** The newest accepted host socket is this one (tags are strictly increasing, so no ties). */
  private newestHostIs(ws: S): boolean {
    let newest = -1;
    for (const h of this.ctx.sockets("host")) newest = Math.max(newest, this.acceptedAt(h));
    return newest >= 0 && this.acceptedAt(ws) === newest;
  }

  private connOf(ws: S, prefix: "c:" | "d:"): string | null {
    const tag = this.ctx.tags(ws).find((t) => t.startsWith(prefix));
    return tag ? tag.slice(2) : null;
  }
}
