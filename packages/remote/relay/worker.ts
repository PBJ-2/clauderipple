// Ripple relay: a Cloudflare Worker with one Durable Object per host (server id). It does two
// things and keeps nothing: forwards encrypted frames between a phone and its host (room.ts), and
// serves the PWA's static files, so the phone has an https origin — the secure context that
// service workers and web push need. Self-hostable: `wrangler deploy` on anyone's account.
//
//   GET /ws/host?server=<id>               host control socket   (header x-ripple-host-secret)
//   GET /ws/host-data?server=<id>&conn=<c> host data socket       (same header)
//   GET /ws/client?server=<id>             phone socket
//   GET /.well-known/apple-app-site-association  iOS Universal Links: the app claims pairing URLs
//   GET /.well-known/assetlinks.json       Android App Links: the Play signing key's fingerprint
//   anything else                          the PWA: static assets (./dist, by build-web.ts), not this worker
import { Room } from "./room.ts";
import type { OutagePush, RoomCtx } from "./room.ts";
import { EXPO_PUSH_URL } from "../src/protocol.ts";

// ---- the slice of the Workers runtime used here (no @cloudflare/workers-types dependency) ----

interface CfSocket { send(data: string | ArrayBuffer | Uint8Array): void; close(code?: number, reason?: string): void }
interface DoState {
  acceptWebSocket(ws: CfSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfSocket[];
  getTags(ws: CfSocket): string[];
  setWebSocketAutoResponse(pair: unknown): void;
  getWebSocketAutoResponseTimestamp(ws: CfSocket): Date | null;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    /** One-shot alarms survive hibernation and eviction: the dead-man switch lives here. */
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}
interface DoStub { fetch(req: Request): Promise<Response> }
interface DoNamespace { idFromName(name: string): unknown; get(id: unknown): DoStub }
interface Env {
  ROOM: DoNamespace;
  ASSETS: { fetch(req: Request): Promise<Response> };
  // Comma-separated SHA-256 fingerprints of the certificates Google Play signs the Android app with
  // (wrangler.toml [vars]). Comma-separated because a debug build's certificate may be added too.
  ANDROID_CERT_SHA256?: string;
}
declare const WebSocketPair: { new (): { 0: CfSocket; 1: CfSocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

const SERVER_RE = /^[\w-]{16,64}$/;

// ---- app links -----------------------------------------------------------------------------------
// The pairing QR is https://<relay>/#pair=…; the fragment never reaches the server, so the path the
// operating system matches is "/". Both files must be served over HTTPS as application/json with
// status 200 and no redirect, or iOS and Android leave the link in the browser.

const ANDROID_PACKAGE = "com.clauderipple.remote";

const APPLE_APP_SITE_ASSOCIATION = JSON.stringify({
  applinks: {
    details: [{
      appIDs: ["QL9967JLCR.com.clauderipple.remote"],
      components: [{ "/": "/" }],
    }],
  },
});

function jsonFile(body: string, head: boolean): Response {
  return new Response(head ? null : body, { status: 200, headers: { "content-type": "application/json" } });
}

function wellKnown(pathname: string, method: string, env: Env): Response | null {
  if (pathname !== "/.well-known/apple-app-site-association" && pathname !== "/.well-known/assetlinks.json") return null;
  if (method !== "GET" && method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const head = method === "HEAD";
  if (pathname === "/.well-known/apple-app-site-association") return jsonFile(APPLE_APP_SITE_ASSOCIATION, head);
  const fingerprints = (env.ANDROID_CERT_SHA256 ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  // An empty list would be an invalid file (Android rejects it, and a later fix would be delayed by
  // the platform's cache), so say "no app" plainly until the Play signing key is filled in.
  if (fingerprints.length === 0) return new Response("not configured", { status: 404 });
  return jsonFile(JSON.stringify([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fingerprints },
  }]), head);
}

function upgrade(ctxAccept: (ws: CfSocket) => void): Response {
  const pair = new WebSocketPair();
  ctxAccept(pair[1]);
  return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
}

export class RelayRoom {
  private state: DoState;
  private room: Room<CfSocket>;

  constructor(state: DoState) {
    this.state = state;
    // Plain "ping" frames (the host's control socket and a phone's socket) are answered by the
    // runtime inside the WebSocket Hibernation API, without invoking or waking the object: an idle
    // room then costs no duration. Room.message answers them too, for an object that is awake.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const ctx: RoomCtx<CfSocket> = {
      accept: (ws, tags) => state.acceptWebSocket(ws, tags),
      sockets: (tag) => state.getWebSockets(tag),
      tags: (ws) => state.getTags(ws),
      lastPing: (ws) => state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null,
      now: () => Date.now(),
      get: (k) => state.storage.get<string>(k),
      put: (k, v) => state.storage.put(k, v),
      setAlarm: (at) => state.storage.setAlarm(at),
      deleteAlarm: () => state.storage.deleteAlarm(),
      // The room sends nowhere but Expo's push endpoint (EXPO_PUSH_URL): no host text, no session.
      postExpo: async (messages: OutagePush[]) => {
        const res = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messages),
        });
        if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
      },
      newId: () => crypto.randomUUID(),
      sha256: async (text) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join(""),
    };
    this.room = new Room(ctx);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const secret = req.headers.get("x-ripple-host-secret");
    const firedAt = url.pathname === "/ws/host" ? await this.room.alertedAt() : undefined;
    switch (url.pathname) {
      case "/ws/host":
        if (!(await this.room.hostAllowed(secret))) return new Response("forbidden", { status: 403 });
        // Read before accepting: a fired alert is said right after the hello, in the same handler.
        return upgrade((ws) => this.room.hostControl(ws, firedAt));
      case "/ws/host-data": {
        const conn = url.searchParams.get("conn") ?? "";
        if (!(await this.room.hostAllowed(secret))) return new Response("forbidden", { status: 403 });
        if (!this.room.hasClient(conn)) return new Response("no such connection", { status: 404 });
        return upgrade((ws) => this.room.hostData(ws, conn));
      }
      case "/ws/client":
        return upgrade((ws) => this.room.client(ws));
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async webSocketMessage(ws: CfSocket, data: string | ArrayBuffer): Promise<void> { await this.room.message(ws, data); }
  webSocketClose(ws: CfSocket, code: number): void {
    this.room.closed(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed"); } catch { /* already closed */ }
  }
  webSocketError(ws: CfSocket): void { this.room.closed(ws); }
  /** The dead-man alarm: the host has not renewed, so its phones are told (Room.alarm). */
  async alarm(): Promise<void> { await this.room.alarm(); }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
      const server = url.searchParams.get("server") ?? "";
      if (!SERVER_RE.test(server)) return new Response("bad server id", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(server)).fetch(req);
    }
    // App-link files and the sockets run here. Everything else is routed to the static assets by
    // wrangler.toml run_worker_first, and only reaches this worker when it must be handed on.
    const appLink = wellKnown(url.pathname, req.method, env);
    if (appLink) return appLink;
    return env.ASSETS.fetch(req);
  },
};
