// The link to the host. It never gives up: after a drop it waits min(30 s, attempt × 1 s) and
// tries again, forever, and at once when the phone comes back online or the app comes to the
// front. A half-open socket (the phone switched networks, the Mac went away without a FIN) is
// caught by the app-level ping, not by TCP; coming back to the front probes the open socket first
// (background age is not proof of death) and only 3 s without a pong drops it. Only a refused token
// stops it, because retrying a token the host rejects would just say "connecting" forever — which
// would be a lie.
//
// Through the relay, every forwarded frame wakes the room's Durable Object. So once the host
// advertises `capabilities.slowHeartbeat`, the end-to-end ping and presence run at SLOW_PING_MS
// instead of PING_MS; between them only the relay's own plain "ping" goes out, which the runtime
// answers without waking the object. The tests pin both cadences.
import { BACKOFF_CAP_MS, PING_MS, READY_MS, SLOW_PING_MS, SLOW_STALE_MS, STALE_MS } from "../src/protocol.ts";
import type { ClientFeature, ClientMsg, HostInfo, HostMsg } from "../src/protocol.ts";
import { FrameAssembler, isChunkFrame, isHostFrame } from "../src/chunks.ts";

/** A socket that opens but never says `ready` is as good as down (through the relay: the handshake counts too). */
export { READY_MS };

/** How long an open socket gets to answer the foreground probe before a new attempt starts. */
export const PROBE_MS = 3_000;

export type LinkState = "connecting" | "open" | "waiting" | "offline" | "denied";

export interface LinkStatus {
  state: LinkState;
  /** consecutive failed attempts since the last good connection */
  attempt: number;
  /** when the next attempt starts (state "waiting") */
  nextAt: number | null;
  /** last time a frame arrived from the host; null if never */
  lastRx: number | null;
  /** when the current outage began; null while open */
  downSince: number | null;
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /**
   * True on a socket to the host through the relay (web/secure.ts) whose relay answers a plain
   * "ping" itself, without waking the room. Absent on a direct WebSocket and on older relays.
   */
  readonly liveness?: boolean;
  /** Send that plain "ping"; its "pong" arrives as a message with data "pong". */
  heartbeat?: () => void;
}

export interface LinkDeps {
  url: string;
  token: string;
  clientId: string;
  /** Explicit opt-in by a client that understands the feature's full response contract. */
  features?: ClientFeature[];
  makeSocket: (url: string) => SocketLike;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  isOnline: () => boolean;
}

export function backoff(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, Math.max(1, attempt) * 1000);
}

export class Link {
  status: LinkStatus = { state: "connecting", attempt: 0, nextAt: null, lastRx: null, downSince: null };
  onMessage: (msg: HostMsg) => void = () => {};
  /** Called on every status change and once a second while waiting, so countdowns stay true. */
  onStatus: (s: LinkStatus) => void = () => {};
  /** Called after the host accepted the token: re-attach sessions, flush the outbox. */
  onReady: () => void = () => {};

  private deps: LinkDeps;
  private sock: SocketLike | null = null;
  /** Chunk frames for this socket; one shot at a time, discarded whenever the socket is replaced. */
  private assembler: FrameAssembler;
  private retryTimer: unknown = null;
  private tickTimer: unknown = null;
  private pingTimer: unknown = null;
  private readyTimer: unknown = null;
  private probeTimer: unknown = null;
  /** The `n` of the probe ping still waiting for its pong, if any. */
  private probeN: number | null = null;
  private pingN = 0;
  private stopped = false;
  /**
   * The host advertised `capabilities.slowHeartbeat`: it sizes its stale and visible windows for
   * SLOW_PING_MS, so this link may drop its end-to-end checks and presence to that cadence. Over
   * the relay that is what lets the room hibernate between checks.
   */
  private slowHost = false;
  /** The last pong the host itself sent (not the relay's liveness answer). */
  private hostPongAt = 0;
  /** The last frame from the host itself, any kind. The relay's own "pong" is not one. */
  private hostRxAt = 0;
  /** When the next end-to-end check is due; the liveness tick runs more often than this. */
  private nextPingAt = 0;
  /**
   * Bumped whenever the timers are dropped. A callback already queued when its timer was cleared
   * still runs (setTimeout cannot cancel what already fired), so it checks the epoch first: this is
   * what keeps a stop, a foreground return or a nudge from reviving an old retry or countdown.
   */
  private epoch = 0;

  constructor(deps: LinkDeps) { this.deps = deps; this.assembler = new FrameAssembler(() => this.deps.now()); }

  start(): void { this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    this.clearAll();
    this.dropSocket(1000, "stop");
  }

  /** Network came back, app came to the front, or the user pressed "retry now". */
  nudge(): void {
    if (this.stopped || this.status.state === "denied") return;
    if (this.status.state === "open") { this.probe(); return; }
    this.connect();
  }

  /**
   * The app came back to the front. The time it spent in the background was the phone's, not the
   * computer's silence: counting it put "no answer for 4 minutes" on screen the moment someone
   * returned from another app (Discord, 2026-10-22). The count starts again from now.
   */
  foreground(): void {
    if (this.status.downSince !== null) this.status = { ...this.status, downSince: this.deps.now() };
    this.nudge();
  }

  send(msg: ClientMsg): boolean {
    if (this.status.state !== "open" || !this.sock) return false;
    try { this.sock.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  private set(patch: Partial<LinkStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  private clearAll(): void {
    this.epoch++;
    for (const id of [this.retryTimer, this.tickTimer, this.pingTimer, this.readyTimer, this.probeTimer]) if (id !== null) this.deps.clearTimer(id);
    this.retryTimer = this.tickTimer = this.pingTimer = this.readyTimer = this.probeTimer = null;
    this.probeN = null;
    // A half-received message belongs to the socket that was carrying it; nothing survives a teardown.
    this.assembler.reset();
  }

  /** Forget the current socket before closing it, so its late close is not read as a live failure. */
  private dropSocket(code: number, reason: string): void {
    const sock = this.sock;
    if (!sock) return;
    this.sock = null;
    try { sock.close(code, reason); } catch { /* already gone */ }
  }

  private connect(): void {
    if (this.stopped) return;
    // One attempt at a time: a nudge or restart abandons the socket still connecting instead of
    // leaving it open beside the new one.
    this.dropSocket(1000, "retry");
    this.clearAll();
    const epoch = this.epoch;
    if (!this.deps.isOnline()) {
      this.set({ state: "offline", nextAt: null, downSince: this.status.downSince ?? this.deps.now() });
      // onStatus is the app's callback: it may have stopped or nudged the link just now.
      if (this.epoch !== epoch) return;
      this.schedule();
      return;
    }
    this.set({ state: "connecting", nextAt: null });
    if (this.epoch !== epoch) return;
    let sock: SocketLike;
    try { sock = this.deps.makeSocket(this.deps.url); } catch { this.fail(); return; }
    this.sock = sock;
    let authed = false;
    sock.onopen = () => {
      if (this.sock !== sock) return;
      this.status.lastRx = this.deps.now();
      sock.send(JSON.stringify({ t: "hello", token: this.deps.token, clientId: this.deps.clientId, features: this.helloFeatures() } satisfies ClientMsg));
      this.armPing();
    };
    // From creation, not from open: a connect that hangs (a dead address after a network switch)
    // may fire neither open nor close for minutes. A chunked ready is progress, not silence, so
    // each slice pushes this deadline out while the whole message is still coming; the assembler's
    // own cap and timeout bound a host that stops halfway.
    let readyArm = 0;
    const armReady = (): void => {
      const arm = ++readyArm;
      if (this.readyTimer !== null) this.deps.clearTimer(this.readyTimer);
      this.readyTimer = this.deps.setTimer(() => {
        // A callback already queued when its timer was cleared still runs; only the latest arming
        // may spend this deadline or clear its reference, or a slice would cancel the new deadline.
        if (arm !== readyArm) return;
        // Only this socket's own timeout may clear the reference first: a queued old one would forget
        // the live connect timeout, and stop() could then leave it running.
        if (this.sock !== sock) return;
        this.readyTimer = null;
        if (authed) return;
        this.sock = null;
        try { sock.close(4002, "no ready"); } catch { /* gone */ }
        this.fail();
      }, READY_MS);
    };
    armReady();
    const deliver = (msg: HostMsg): void => {
      if (msg.t === "pong") {
        // Any pong is the host itself, and proves the end-to-end path even on the slow cadence.
        this.hostPongAt = this.deps.now();
        // Only the answer to the probe still pending clears it; an older pong (or a later one after
        // the probe timed out) changes nothing.
        if (this.probeN !== null && msg.n === this.probeN) this.clearProbe();
        return;
      }
      if (msg.t === "denied") {
        this.clearAll();
        this.sock = null;
        sock.close(4001, "denied");
        this.set({ state: "denied", nextAt: null });
        return;
      }
      if (msg.t === "ready" && !authed) {
        authed = true;
        // `ready` is the host's own word, so the link is alive even before the first pong.
        this.hostPongAt = this.deps.now();
        this.observeHost(msg.host);
        this.set({ state: "open", attempt: 0, nextAt: null, downSince: null });
        this.onReady();
      }
      if (msg.t === "host") this.observeHost(msg.host);
      this.onMessage(msg);
    };
    sock.onmessage = (ev) => {
      if (this.sock !== sock) return;
      this.status.lastRx = this.deps.now();
      // The relay's liveness answer proves the socket to the relay, not the host behind it.
      if (ev.data === "pong") return;
      this.hostRxAt = this.deps.now();
      let parsed: unknown;
      try { parsed = JSON.parse(String(ev.data)); } catch { return; }
      if (isChunkFrame(parsed)) {
        // Only ever sent to a client that asked for them; a host that does it anyway is not
        // speaking this contract, and a lie is worse than a reconnect.
        if (!this.deps.features?.includes("chunkedFrames")) return;
        if (!authed) armReady();
        const result = this.assembler.push(parsed);
        if (result.kind === "pending") return;
        if (result.kind === "error") { this.dropChunked(sock); return; }
        // The assembled text is the exact frame the host serialized; it takes the normal path,
        // including the `ready` that opens the link and stops the connect deadline. Anything that
        // is not one host frame (null, an array, another chunk envelope) is not delivered at all.
        let assembled: unknown;
        try { assembled = JSON.parse(result.text); } catch { this.dropChunked(sock); return; }
        if (!isHostFrame(assembled)) { this.dropChunked(sock); return; }
        parsed = assembled;
      }
      deliver(parsed as HostMsg);
    };
    sock.onclose = () => { if (this.sock === sock) this.fail(); };
    sock.onerror = () => { /* onclose follows */ };
  }

  /** A slice that cannot be completed or is malformed: reconnect instead of waiting for a frame that will never come. */
  private dropChunked(sock: SocketLike): void {
    if (this.sock !== sock) return;
    this.sock = null;
    try { sock.close(4002, "bad chunk"); } catch { /* gone */ }
    this.fail();
  }

  private fail(immediate = false): void {
    this.sock = null;
    this.clearAll();
    const epoch = this.epoch;
    if (this.stopped || this.status.state === "denied") return;
    this.set({ attempt: this.status.attempt + 1, downSince: this.status.downSince ?? this.deps.now() });
    if (this.epoch !== epoch) return;
    if (immediate) this.connect(); else this.schedule();
  }

  private schedule(): void {
    const epoch = this.epoch;
    const wait = backoff(this.status.attempt);
    const nextAt = this.deps.now() + wait;
    if (this.status.state !== "offline") {
      this.set({ state: "waiting", nextAt });
      if (this.epoch !== epoch) return;
    }
    this.retryTimer = this.deps.setTimer(() => {
      if (this.epoch !== epoch) return;
      this.retryTimer = null;
      this.connect();
    }, wait);
    const tick = (): void => {
      if (this.epoch !== epoch) return;
      this.onStatus(this.status);
      if (this.epoch !== epoch) return;
      this.tickTimer = this.deps.setTimer(tick, 1000);
    };
    this.tickTimer = this.deps.setTimer(tick, 1000);
  }

  /**
   * The link's one period: PING_MS. Each beat tells the relay this socket is alive (plain "ping",
   * answered by the runtime without waking the room) and, when the end-to-end check is due, asks
   * the host. The check is spaced at the host's cadence, so an idle phone forwards nothing between
   * checks and the room may hibernate.
   */
  private armPing(): void {
    const epoch = this.epoch;
    this.nextPingAt = this.deps.now() + this.cadence();
    const loop = (): void => {
      if (this.epoch !== epoch) return;
      this.tick();
      if (this.epoch !== epoch) return;
      this.pingTimer = this.deps.setTimer(loop, PING_MS);
    };
    this.pingTimer = this.deps.setTimer(loop, PING_MS);
  }

  private tick(): void {
    const sock = this.sock;
    if (!sock) return;
    if (this.assembler.expire()) {
      // A slice stopped arriving; the rest of that message will never come. Starting over is the
      // only way to get a complete one, and it costs one reconnect.
      this.sock = null;
      try { sock.close(4002, "lost chunks"); } catch { /* gone */ }
      this.fail(true);
      return;
    }
    if (sock.liveness === true) try { sock.heartbeat?.(); } catch { /* close follows */ }
    const now = this.deps.now();
    if (now < this.nextPingAt) return;
    this.nextPingAt = now + this.cadence();
    this.check(now);
  }

  /** The cadence the host's capability allows: its own stale/visible windows match it. */
  private cadence(): number { return this.slowHost ? SLOW_PING_MS : PING_MS; }

  private check(now: number): void {
    if (this.slowHost) {
      // A slow link is quiet by design, so only evidence counts. A host that has not answered a
      // check for three beats is probed; so is a relay socket whose runtime stopped answering.
      const relaySilent = this.sock?.liveness === true && now - (this.status.lastRx ?? 0) > STALE_MS;
      if (now - this.hostPongAt >= SLOW_STALE_MS || relaySilent) { this.probe(); return; }
      this.sendPing();
      return;
    }
    // Only the host's own frames count: relay pongs keep arriving from a room whose host died.
    if (now - this.hostRxAt > STALE_MS) {
      // Silence may be the phone's background, not the host's. Probe before dropping: a socket that
      // is actually alive answers and stays, and the probe's timeout does the dropping.
      this.probe();
      return;
    }
    this.sendPing();
  }

  private sendPing(): void {
    const sock = this.sock;
    if (!sock) return;
    try { sock.send(JSON.stringify({ t: "ping", n: ++this.pingN } satisfies ClientMsg)); } catch { /* close follows */ }
  }

  /** This Link understands the slow cadence; a host that also does says so in its capabilities. */
  private helloFeatures(): ClientFeature[] {
    const features = [...(this.deps.features ?? [])];
    if (!features.includes("slowHeartbeat")) features.push("slowHeartbeat");
    return features;
  }

  /** The host's own advertisement decides the cadence for this connection. */
  private observeHost(host: HostInfo): void {
    const slow = host.capabilities?.slowHeartbeat === true;
    if (slow === this.slowHost) return;
    this.slowHost = slow;
    this.nextPingAt = this.deps.now() + this.cadence();
  }

  /**
   * The app came back to the front. Ask the open socket to answer now instead of trusting its age:
   * the time it spent in the background was the phone's, not the computer's silence. One probe at a
   * time, however often foreground/nudge repeats; a matching pong keeps the socket, and only
   * PROBE_MS without one drops it and starts a new attempt.
   */
  private probe(): void {
    const sock = this.sock;
    if (!sock || this.probeTimer !== null) return;
    const n = ++this.pingN;
    const epoch = this.epoch;
    this.probeN = n;
    this.probeTimer = this.deps.setTimer(() => {
      if (this.epoch !== epoch || this.probeN !== n) return;
      this.probeTimer = null;
      this.probeN = null;
      if (this.sock !== sock) return;
      this.sock = null;
      try { sock.close(4000, "probe timeout"); } catch { /* already gone */ }
      this.fail(true);
    }, PROBE_MS);
    try { sock.send(JSON.stringify({ t: "ping", n } satisfies ClientMsg)); } catch { /* close follows */ }
  }

  private clearProbe(): void {
    if (this.probeTimer !== null) this.deps.clearTimer(this.probeTimer);
    this.probeTimer = null;
    this.probeN = null;
  }
}
