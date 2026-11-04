// One host's room on the relay: the host's control socket, and one pair of sockets per phone
// connection (the phone's, and the host's data socket for it). The room forwards frames between a
// pair untouched — they are end-to-end encrypted (src/e2ee.ts) — and never stores one.
//
// Pure logic over a small context, so it runs the same inside the Durable Object (worker.ts, where
// the context is the hibernation API: tags survive the object sleeping between frames) and in an
// in-process test with fake sockets.
import { HOST_SILENT_MS, RELAY_CLOSE, RELAY_FRAME_CAP } from "../src/protocol.ts";
import type { RelayMsg } from "../src/protocol.ts";

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
  newId(): string;
  sha256(text: string): Promise<string>;
}

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
  hostControl(ws: S): void {
    const old = this.ctx.sockets("host");
    // Strictly increasing even within one millisecond, so "newest" is never a tie.
    const at = Math.max(this.ctx.now(), ...old.map((o) => this.acceptedAt(o) + 1));
    this.ctx.accept(ws, ["host", `at:${at}`]);
    for (const o of old) shut(o, RELAY_CLOSE.replaced, "replaced");
    say(ws, { relay: "hello" });
    // Phones that arrived while the host was away and still have no data socket.
    for (const c of this.ctx.sockets("client")) {
      const conn = this.connOf(c, "c:");
      if (conn && !this.ctx.sockets(`d:${conn}`).length) say(ws, { relay: "connect", conn });
    }
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

  message(ws: S, data: string | ArrayBuffer): void {
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
    if (tags.includes("host")) return; // only pings come this way
    const phone = this.connOf(ws, "c:");
    if (phone) { for (const d of this.ctx.sockets(`d:${phone}`)) d.send(data); return; }
    const host = this.connOf(ws, "d:");
    if (host) for (const c of this.ctx.sockets(`c:${host}`)) c.send(data);
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

  private connOf(ws: S, prefix: "c:" | "d:"): string | null {
    const tag = this.ctx.tags(ws).find((t) => t.startsWith(prefix));
    return tag ? tag.slice(2) : null;
  }
}
