// The phone app: one screen at a time (pair, home, session), a docked composer, sheets for
// folder and model. State that must survive closing the app (the token, unsent messages, the
// last folder and model) lives in localStorage; everything else is rebuilt from the host.
import type { BlobChunk, BrowseResult, ClientMsg, DiffScope, DiffView, Effort, FolderEntry, HostMsg, ProviderGroup, Question, ReqOp, SessionEvent, SessionSummary, SubPage } from "../src/protocol.ts";
import { Link } from "./conn.ts";
import type { LinkStatus } from "./conn.ts";
import { esc, icon } from "./dom.ts";
import { patchList, setHTML } from "./html.ts";
import { lang, pickLang, setLang, t } from "./i18n.ts";
import { browserPushEnv, currentSubscription, enablePush, sameKey } from "./notify.ts";
import { adopt, autoSendable, createSend, hostIdentity, loadOutbox, named, outboxStart, preserved, refuse, requeue, writeOutbox } from "./outbox.ts";
import type { OutboxEntry, OutboxStart, PreservedItem } from "./outbox.ts";
import { pushAvailability } from "./pushstate.ts";
import { RelaySocket, browserNacl, relayClientUrl } from "./secure.ts";
import type { RawSocket, RelayPairing } from "./secure.ts";
import { PING_MS, defaultEffort } from "../src/protocol.ts";
import { mergeEvents, reduce, timelineItems, workerFor, workerPrompt, workerConversationItems } from "./timeline.ts";
import type { TimelineItem, SessionView } from "./timeline.ts";
import * as V from "./views.ts";
import type { UI } from "./views.ts";
import { watchFrames } from "./watch.ts";
import { emptyQuestionDraft, freeAnswer, questionAnswers, questionsComplete, toggleOption, type QuestionDraft } from "./question-answers.ts";

/** Where the reader is in a conversation: at its newest message, or at the row whose start sits
 * `inset` pixels below the top edge of the screen (negative when that start is above it). */
type Position = "bottom" | { key: string; inset: number };
interface Cache { epoch: string | null; events: SessionEvent[]; hasOlder: boolean; loadingOlder: boolean; olderReq: string | null; olderEpoch: string | null; olderCursor: number | null; olderTimer: ReturnType<typeof setTimeout> | null; olderFailed: boolean; scroll: Position | null }
type Screen = { name: "pair" } | { name: "home" } | { name: "session"; id: string };

const store = {
  getItem(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* private mode: state lives for this visit only */ }
  },
  get<T>(key: string, fallback: T): T {
    const raw = store.getItem(key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { store.setItem(key, JSON.stringify(value)); } catch { /* not serializable: nothing to keep */ }
  },
};

/**
 * A list of names this device stored (pins, folded sections). Anything that is not a list of
 * strings is treated as nothing stored, so one damaged value cannot hide the whole list.
 */
function storedKeys(key: string, fallback: string[]): string[] {
  const raw = store.get<unknown>(key, fallback);
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : fallback;
}

/**
 * localStorage as it is, for the outbox. Unlike `store` above it does not turn a refused read into
 * "nothing stored": the outbox has to tell an empty queue from a value it could not read, or it
 * would write over the person's words (B05/B16). Throw here; the outbox module reports it.
 */
const rawStorage = {
  getItem: (key: string): string | null => localStorage.getItem(key),
  setItem: (key: string, value: string): void => { localStorage.setItem(key, value); },
  keys: (): string[] => Object.keys(localStorage),
};

/** What the phone says when the queue could not be read, cannot be stored, or cannot tell its computer. */
function noticeText(notice: NonNullable<OutboxStart["notice"]>): string {
  switch (notice) {
    case "no-identity": return t("outbox.identityUnknown");
    case "unavailable": return t("outbox.storageUnavailable");
    case "partial":
    case "unreadable": return t("outbox.unreadable");
  }
}

/** Keep the pairing a link's fragment carries ("#pair=…"); false when it carries none. */
function savePairing(fragment: string): boolean {
  if (!fragment.startsWith("#")) return false;
  const hash = new URLSearchParams(fragment.slice(1));
  const paired = hash.get("pair");
  if (!paired) return false;
  store.set("rr.token", paired);
  // A relay pairing names the host (server id) and its key; a direct one does not, and replaces any relay pairing.
  const server = hash.get("server"), hpk = hash.get("hpk");
  store.set("rr.relay", server && hpk ? ({ url: location.origin, server, hpk } satisfies RelayPairing) : null);
  return true;
}

const uid = (): string => crypto.randomUUID();
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export class App {
  ui: UI;
  screen: Screen = { name: "home" };
  caches = new Map<string, Cache>();
  /** Unsent messages of the computer this phone is paired with: see outbox.ts (B05). Loaded by start(). */
  outbox: OutboxEntry[] = [];
  recentModels: string[] = store.get<string[]>("rr.recentModels", []);
  link: Link | null = null;
  pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** create's clientMsgId → session id, once the host acknowledged it */
  created = new Map<string, string>();
  /** Where this computer's unsent messages live; null before start() knows the pairing (or cannot tell). */
  private outboxKey: string | null = null;
  /** False while a stored queue that was not read back whole (or could not be written) must not be overwritten. */
  private outboxWritable = false;
  /** Whether this browser is keeping the queue: false after a refused write, so nothing is sent on its own. */
  private outboxDurable = false;
  /** What start() had to say about the stored queue, kept so a send can be refused the same way. */
  private outboxNotice: OutboxStart["notice"] = null;
  /** Said once per failure streak; cleared by a write that succeeds again. */
  private outboxWarned = false;
  /** The session the host was last told this phone is looking at: see watch.ts (B17). */
  private watching: string | null = null;
  private renderedScreen = "";
  private composerMode = "";
  private lastOpenPerm = "";
  private pinned = true;
  private tasksOpen = false;
  private planOpen = false;
  private taskSeen = new Map<string, Set<string>>();
  private questionStates = new Map<string, { drafts: Map<string, QuestionDraft>; deciding: Set<string> }>();

  private questionState(session: string) {
    const key = JSON.stringify([session, this.cache(session).epoch]);
    let state = this.questionStates.get(key);
    if (!state) { state = { drafts: new Map(), deciding: new Set() }; this.questionStates.set(key, state); }
    return state;
  }
  private workerPath: V.WorkerSheet[] = [];
  private timelineSize: ResizeObserver | null = null;
  private imageUrls = new Map<string, Promise<string>>();
  /** Where a diff file was last left, by session and path, so it opens where it was read. */
  private diffOffsets = new Map<string, number>();

  private clearImages(): void {
    for (const url of this.imageUrls.values()) void url.then(value => URL.revokeObjectURL(value), () => undefined);
    this.imageUrls.clear();
  }

  private hydrateImages(root: HTMLElement, session: string): void {
    for (const el of root.querySelectorAll<HTMLElement>('.conversation-image')) {
      if (el.dataset.loading) continue;
      el.dataset.loading = 'true';
      const id = el.dataset.blob!, media = el.dataset.media!;
      let loading = this.imageUrls.get(id);
      if (!loading) {
        loading = (async () => {
          let offset = 0, base64 = '';
          for (;;) {
            const chunk = await this.req<BlobChunk>({ op: 'blob', session, id, offset });
            base64 += chunk.text;
            if (chunk.next === null) break;
            offset = chunk.next;
          }
          const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
          return URL.createObjectURL(new Blob([bytes], { type: media }));
        })();
        this.imageUrls.set(id, loading);
      }
      void loading.then(url => {
        if (!el.isConnected) return;
        const image = el.querySelector('img')!;
        image.onerror = () => { image.hidden = true; el.querySelector('span')!.textContent = t('image.unavailable'); };
        image.onload = () => { el.querySelector('span')!.textContent = ''; };
        image.src = url; image.hidden = false;
      }, error => {
        if (el.isConnected) el.querySelector('span')!.textContent = t('image.unavailable');
        this.toast(t('error.generic', { text: (error as Error).message }));
      });
    }
  }

  constructor(link: LinkStatus) {
    this.ui = {
      now: Date.now(), link, host: null, home: undefined, sessions: [], models: [], sheet: null,
      draft: store.get("rr.draft", { cwd: null, model: null, effort: null }),
      expanded: new Map(), workersOpen: false, permOpen: new Set(), questionDrafts: new Map(), deciding: new Set(), toast: null,
      // Pins and folds belong to this device, so they live beside the draft and the typed drafts.
      pins: storedKeys("rr.pins", []), folded: storedKeys("rr.folded", [V.ARCHIVE_KEY]),
      query: "", homeLimit: V.HOME_PAGE,
      push: null, pushLater: store.get<boolean>("rr.pushLater", false),
    };
  }

  // ---- boot --------------------------------------------------------------------------------

  /** Resolves once the pairing is known and the first screen is up; awaiting only the token fingerprint. */
  async start(): Promise<void> {
    if (savePairing(location.hash)) history.replaceState(null, "", location.pathname);
    const token = store.get<string | null>("rr.token", null);
    if (!token) { this.screen = { name: "pair" }; this.bind(); this.render(); return; }
    this.screen = this.routeFromHash();
    window.addEventListener("hashchange", () => { this.rememberPosition(); this.screen = this.routeFromHash(); this.workerPath = []; this.ui.sheet = null; this.render(); this.attachCurrent(); });
    const clientId = store.get<string>("rr.clientId", "") || uid();
    store.set("rr.clientId", clientId);
    // Served by the relay → through the relay, encrypted end to end; served by the host itself → straight to it.
    // The same pairing names the computer whose unsent messages this phone keeps: switching computers
    // keeps each one's queue, and two computers never share one (B05).
    const relay = store.get<RelayPairing | null>("rr.relay", null);
    const identity = await hostIdentity({ relay, origin: location.origin, token });
    const viaRelay = identity?.kind === "relay" ? relay : null;
    const outcome = outboxStart(identity, rawStorage);
    this.outboxKey = outcome.key;
    this.outbox = outcome.entries;
    this.outboxWritable = outcome.writable;
    this.outboxDurable = outcome.writable;
    this.outboxNotice = outcome.notice;
    // A queue that was not read back whole is never written over, and a direct pairing this browser
    // cannot fingerprint stores nothing and sends nothing: say which one happened instead of
    // behaving as if the queue were simply empty.
    if (outcome.notice !== null) this.toast(noticeText(outcome.notice));
    this.refreshRecovery();
    const link = new Link({
      url: viaRelay ? relayClientUrl(viaRelay) : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      token, clientId,
      // Only the transport chunks are asked for; the rest of this client's answers stay as they are.
      features: ["chunkedFrames"],
      makeSocket: viaRelay
        ? (url) => new RelaySocket(new WebSocket(url) as unknown as RawSocket, viaRelay, browserNacl())
        : (url) => new WebSocket(url) as unknown as import("./conn.ts").SocketLike,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as number),
      isOnline: () => navigator.onLine,
    });
    this.link = link;
    link.onStatus = (s) => {
      // A page asked for on a socket that just dropped will not arrive: say so instead of spinning.
      if (s.state !== "open") for (const c of [...this.caches.values()]) if (c.olderReq !== null) this.failOlder(c.olderReq);
      this.ui.link = s; this.ui.now = Date.now(); this.renderChrome();
    };
    link.onMessage = (m) => this.onHost(m);
    link.onReady = () => this.onReady();
    window.addEventListener("online", () => link.nudge());
    window.addEventListener("offline", () => link.nudge());
    document.addEventListener("visibilitychange", () => { this.sendPresence(); if (document.visibilityState === "visible") { link.foreground(); void this.refreshPush(); } });
    setInterval(() => { this.ui.now = Date.now(); this.renderChrome(); }, 1000);
    // While in front, say so every PING_MS: the host pushes nothing to a phone that is looking, and
    // stops counting one whose app froze in the background without saying "hidden".
    setInterval(() => { if (document.visibilityState === "visible") this.sendPresence(); }, PING_MS);
    if (window.isSecureContext && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.ts", { scope: "./" }).catch(() => undefined);
    }
    void this.refreshPush();
    this.bind();
    this.render();
    link.start();
  }

  private routeFromHash(): Screen {
    const m = /^#\/s\/(.+)$/.exec(location.hash);
    return m ? { name: "session", id: decodeURIComponent(m[1]!) } : { name: "home" };
  }

  go(screen: Screen): void {
    // Where the reader is belongs to the conversation being left, not to the one being opened.
    this.rememberPosition();
    const hash = screen.name === "session" ? `#/s/${encodeURIComponent(screen.id)}` : "";
    if (location.hash !== hash) {
      if (hash) location.hash = hash; else history.pushState(null, "", location.pathname);
    }
    this.screen = screen;
    this.workerPath = [];
    this.ui.sheet = null;
    this.render();
    this.attachCurrent();
  }

  // ---- host messages -----------------------------------------------------------------------

  private onReady(): void {
    // The host drops every attachment with the socket it was made on, so this one knows nothing yet.
    this.watching = null;
    this.sendPresence();
    this.attachCurrent();
    this.flushOutbox(null);
    if (!this.ui.models.length) void this.loadModels();
    void this.resyncPush();
  }

  // ---- presence and notifications ----------------------------------------------------------

  private sendPresence(): void {
    this.link?.send({ t: "presence", visible: document.visibilityState === "visible" });
  }

  private async refreshPush(): Promise<void> {
    const sub = await currentSubscription().catch(() => null);
    const next = pushAvailability(browserPushEnv(sub !== null));
    if (next !== this.ui.push) { this.ui.push = next; if (this.screen.name === "home") this.render(); }
  }

  /** A host may have dropped the subscription (a 410 it saw) or changed its key: tell it again on every connect. */
  private async resyncPush(): Promise<void> {
    try {
      const sub = await currentSubscription();
      if (!sub || Notification.permission !== "granted") return;
      const { publicKey } = await this.req<{ publicKey: string }>({ op: "push_key" });
      if (!sameKey(sub, publicKey)) { await sub.unsubscribe(); await this.refreshPush(); return; }
      await this.registerPush(sub.toJSON());
    } catch { /* tried again on the next connect */ }
  }

  private async registerPush(json: PushSubscriptionJSON): Promise<void> {
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("subscription without keys");
    await this.req({ op: "push_subscribe", subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, lang: lang() });
  }

  private async turnOnPush(): Promise<void> {
    try {
      const r = await enablePush(async () => (await this.req<{ publicKey: string }>({ op: "push_key" })).publicKey, (json) => this.registerPush(json));
      if (r === "on") this.toast(t("push.done"));
    } catch (e) { this.toast(t("push.failed", { text: (e as Error).message })); }
    await this.refreshPush();
  }

  onHost(m: HostMsg): void {
    switch (m.t) {
      case "ready":
        this.ui.host = m.host; this.ui.sessions = m.sessions; this.ui.groups = m.groups; this.render(); break;
      case "host":
        this.ui.host = m.host; this.renderChrome(); break;
      case "sessions":
        this.ui.sessions = m.sessions; this.ui.groups = m.groups; if (this.screen.name === "home") this.render(); else this.renderChrome(); break;
      case "events": {
        const c = this.cache(m.session);
        const first = m.events[0]?.seq, last = m.events.at(-1)?.seq;
        const oldFirst = c.events[0]?.seq, oldLast = c.events.at(-1)?.seq;
        const connected = c.epoch === m.epoch && first !== undefined && last !== undefined && oldFirst !== undefined && oldLast !== undefined && first <= oldLast + 1 && last >= oldFirst - 1;
        const replace = (c.epoch !== null && c.epoch !== m.epoch) || (!!m.tail && !connected);
        if (replace) {
          this.cancelOlder(c);
          c.events = [];
          c.hasOlder = m.tail?.hasOlder ?? false;
        } else if (m.tail && (oldFirst === undefined || first !== undefined && first <= oldFirst)) {
          c.hasOlder = m.tail.hasOlder;
        }
        c.epoch = m.epoch;
        c.events = mergeEvents(c.events, m.events);
        for (const e of m.events) {
          if (e.kind === "user") this.dropOutbox(e.clientMsgId);
          if (e.kind === "permission_decided") this.questionState(m.session).deciding.delete(e.id);
        }
        if (this.isCurrent(m.session)) this.renderSession();
        this.followWorker(m.session);
        break;
      }
      case "history": {
        const c = this.cache(m.session);
        if (!c.loadingOlder || c.olderReq !== m.reqId || c.olderEpoch !== c.epoch || (m.epoch !== undefined && m.epoch !== c.olderEpoch)) break;
        if (c.events[0]?.seq !== c.olderCursor) { this.failOlder(m.reqId); break; }
        this.cancelOlder(c);
        // A page that adds nothing ends the asking: the host has nothing older to give.
        c.hasOlder = m.events.length ? m.hasOlder : false;
        // The page went in above what the reader is looking at; the row they were on stays put.
        const anchor = this.isCurrent(m.session) && !this.pinned ? this.topRow() : null;
        c.events = mergeEvents(c.events, m.events);
        if (this.isCurrent(m.session)) { this.renderSession(); if (anchor) this.place(anchor); }
        break;
      }
      case "ack": {
        const entry = this.outbox.find((o) => o.clientMsgId === m.clientMsgId);
        if (entry && entry.session && entry.session !== m.session && this.isCurrent(entry.session)) this.go({ name: "session", id: m.session });
        if (entry?.create) {
          this.created.set(m.clientMsgId, m.session);
          if (this.screen.name === "session" && this.screen.id === `local:${m.clientMsgId}`) {
            history.replaceState(null, "", `#/s/${encodeURIComponent(m.session)}`);
            this.screen = { name: "session", id: m.session };
            this.renderedScreen = "";
          }
        }
        this.dropOutbox(m.clientMsgId);
        this.attachCurrent();
        this.render();
        break;
      }
      case "res": {
        // A refused page of earlier history is the reader's to retry; refusals for other requests
        // are not the timeline's.
        if (!m.ok) this.failOlder(m.reqId);
        const p = this.pending.get(m.reqId);
        this.pending.delete(m.reqId);
        if (p) { if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error)); }
        break;
      }
      case "error": {
        // Nothing the person wrote is thrown away here (B16). `outcome_unknown` may have run, so the
        // entry stays as it is and the next connect asks again under the same id; `host_updating` is
        // transient and goes back to pending for that reconnect; any other refusal is the host saying
        // no to this message, kept with the host's own reason until the person retries it or takes
        // the words back.
        const before = this.outbox;
        if (m.clientMsgId) {
          this.outbox = refuse(this.outbox, m.clientMsgId, m.code, m.message);
          if (this.outbox !== before) {
            if (!this.saveOutbox()) this.warnNotSaved(false);
            this.refreshRecovery();
            if (this.screen.name === "session") this.renderSession();
          }
        }
        this.toast(t("error.generic", { text: m.message }));
        break;
      }
      default:
        break;
    }
  }

  private isCurrent(session: string): boolean {
    return this.screen.name === "session" && this.screen.id === session;
  }

  cache(id: string): Cache {
    let c = this.caches.get(id);
    if (!c) { c = { epoch: null, events: [], hasOlder: false, loadingOlder: false, olderReq: null, olderEpoch: null, olderCursor: null, olderTimer: null, olderFailed: false, scroll: null }; this.caches.set(id, c); }
    return c;
  }

  /**
   * Keep the host's idea of what this phone is looking at equal to the screen. An attached session
   * is one the host streams to and counts as being read, so a phone that only ever attaches goes on
   * silencing every session it walked through (B17): leaving one has to be said.
   */
  private attachCurrent(): void {
    const next = this.screen.name === "session" && !this.screen.id.startsWith("local:") ? this.screen.id : null;
    const { detach, attach } = watchFrames(this.watching, next);
    if (detach !== null) {
      // A closed socket means the host already forgot it, so a refused send changes nothing here.
      this.link?.send({ t: "detach", session: detach });
      this.watching = null;
    }
    if (attach === null || this.ui.link.state !== "open") return;
    const c = this.cache(attach);
    const last = c.events.length ? c.events[c.events.length - 1]!.seq : 0;
    const msg: ClientMsg = c.epoch && last ? { t: "attach", session: attach, epoch: c.epoch, afterSeq: last } : { t: "attach", session: attach };
    if (this.link?.send(msg)) this.watching = attach;
  }

  req<T>(op: ReqOp): Promise<T> { return this.requestFrame(reqId => ({ t: "req", reqId, op })); }

  private requestFrame<T>(frame: (reqId: string) => ClientMsg): Promise<T> {
    const reqId = uid();
    return new Promise<T>((resolve, reject) => {
      if (!this.link?.send(frame(reqId))) { reject(new Error("offline")); return; }
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => { if (this.pending.delete(reqId)) reject(new Error("timeout")); }, 15_000);
    });
  }

  private async loadModels(): Promise<void> {
    try {
      this.ui.models = await this.req<ProviderGroup[]>({ op: "models" });
      const d = this.ui.draft;
      const all = this.ui.models.flatMap((g) => g.models);
      if (!d.model || !all.some((m) => m.model === d.model)) {
        const first = all.find((m) => m.usable);
        if (first) { d.model = first.model; d.effort = first.efforts.includes("high") ? "high" : first.efforts[0] ?? null; store.set("rr.draft", d); }
      }
      this.render();
    } catch { /* retried on the next ready */ }
  }

  // ---- outbox: nothing a person typed is dropped; nothing shows as sent before the host says so ----

  /**
   * Write the queue. True means the browser is keeping it. A stored value that was not read back
   * whole is never written over: it may hold words this app could not parse (B05/B16).
   */
  private saveOutbox(): boolean {
    if (this.outboxKey === null || !this.outboxWritable) { this.outboxDurable = false; return false; }
    const saved = writeOutbox(rawStorage, this.outboxKey, this.outbox);
    this.outboxDurable = saved.ok;
    if (saved.ok) this.outboxWarned = false;
    return saved.ok;
  }

  /**
   * Say that the queue is not being kept. Once per failure streak for background writes; always for
   * something the person just did, or the tap would look like it did nothing.
   */
  private warnNotSaved(always: boolean): void {
    if (!always && this.outboxWarned) return;
    this.outboxWarned = true;
    this.toast(t("outbox.saveFailed"));
  }

  private dropOutbox(id: string): void {
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((o) => o.clientMsgId !== id);
    if (this.outbox.length !== before) { if (!this.saveOutbox()) this.warnNotSaved(false); this.refreshRecovery(); }
  }

  /**
   * Send queued messages. `null` is a pass nobody asked for (a reconnect): only the messages this
   * browser is keeping, and only while it is keeping them. An array is a person's own action and
   * sends exactly those ids — never whatever else happens to be waiting beside them.
   *
   * The intent reaches the disk before the frame reaches the socket. After that point a reload must
   * read the message as "may have run" (`sending`), never as never-sent: an edited retry of a
   * message that actually went out would otherwise start the same session twice. A message this
   * phone could not keep is not sent at all, and its words stay where the person can still copy them.
   */
  private flushOutbox(ids: readonly string[] | null): void {
    // A refused write is not a permanent queue lock: on reconnect first try to make the current
    // queue durable again. Nothing is selected for automatic sending until that write succeeds.
    if (ids === null && !this.outboxDurable && this.outboxWritable && this.outbox.length > 0) {
      if (!this.saveOutbox()) this.warnNotSaved(false);
    }
    const sendable = ids === null ? autoSendable(this.outbox, this.outboxDurable) : named(this.outbox, ids);
    if (sendable.length === 0) { this.render(); return; }
    const was = sendable.map((entry) => entry.state);
    for (const entry of sendable) entry.state = "sending";
    if (!this.saveOutbox()) {
      // Nothing left the phone; the words are still exactly as the person left them.
      sendable.forEach((entry, i) => { entry.state = was[i] ?? "pending"; });
      this.warnNotSaved(ids !== null);
      this.render();
      return;
    }
    let changed = false;
    for (const o of sendable) {
      const session = o.session ?? null;
      const sent = o.create && !session
        ? this.link?.send({ t: "create", clientMsgId: o.clientMsgId, cwd: o.create.cwd, model: o.create.model, effort: o.create.effort, text: o.text })
        : session ? this.link?.send({ t: "send", session, clientMsgId: o.clientMsgId, text: o.text }) : false;
      // Never left the phone: say so, and try to keep saying so. If even this write fails, the stored
      // "sending" is the conservative side — the person retries under the same id, which is idempotent.
      if (!sent) { o.state = "pending"; changed = true; }
    }
    if (changed) this.saveOutbox();
    this.render();
  }

  /**
   * Queue what the composer holds. False means nothing was queued and the words must stay in the
   * field. A message that was already sent, or whose outcome is unknown, is never replaced here:
   * that is the person's decision, made on the message itself, not a side effect of pressing send.
   */
  submit(text: string): boolean {
    const screen = this.screen;
    const body = text.trim();
    if (!body || (screen.name === "session" && this.summary(screen.id)?.readOnly)) return false;
    // A message that cannot be tied to one computer, or kept anywhere, is not sent at all: the words
    // stay in the field, which is the one place they are certain to survive (B05/B16).
    if (this.outboxKey === null) { this.toast(t("outbox.identityUnknown")); return false; }
    if (this.outboxNotice === "unavailable") { this.toast(t("outbox.storageUnavailable")); return false; }
    if (screen.name === "home" || (screen.name === "session" && screen.id.startsWith("local:"))) {
      const d = this.ui.draft;
      // A local screen names the create this phone is still waiting on. Its id is only reused for
      // the same words: a retry keeps the id (the host would otherwise start a second session),
      // while edited words are a new message — the entry they replace was refused or never sent, so
      // retiring it here loses nothing (outbox.ts createSend).
      const local = screen.name === "session" ? screen.id.slice(6) : null;
      const held = local === null ? undefined : this.outbox.find((o) => o.clientMsgId === local);
      const plan = createSend(held, body, uid);
      // A create already on its way, or one whose outcome the host could not confirm, is not
      // replaced from here: that is the person's decision, made on the message itself.
      if (plan.kind === "held") { this.toast(t("outbox.waiting")); return false; }
      let create = held?.create ?? null;
      if (!create) {
        if (!d.cwd) { this.openFolderSheet(); return false; }
        if (!d.model) { this.openModelSheet(null); return false; }
        create = { cwd: d.cwd, model: d.model, effort: d.effort };
      }
      const before = this.outbox;
      const rest = before.filter((o) => o.clientMsgId !== held?.clientMsgId && o.clientMsgId !== plan.clientMsgId);
      this.outbox = [...rest, { clientMsgId: plan.clientMsgId, text: body, at: Date.now(), state: "pending", session: null, create }];
      // A message the browser will not keep is not sent and not left as a phantom in the queue: the
      // words stay in the field, which is the copy that survives (B16).
      if (!this.saveOutbox()) { this.outbox = before; this.warnNotSaved(true); return false; }
      this.rememberModel(create.model);
      this.flushOutbox([plan.clientMsgId]);
      this.go({ name: "session", id: `local:${plan.clientMsgId}` });
      return true;
    }
    if (screen.name !== "session") return false;
    const before = this.outbox;
    const queued: OutboxEntry = { clientMsgId: uid(), text: body, at: Date.now(), state: "pending", session: screen.id };
    this.outbox = [...before, queued];
    if (!this.saveOutbox()) { this.outbox = before; this.warnNotSaved(true); return false; }
    this.flushOutbox([queued.clientMsgId]);
    this.scrollToBottom();
    return true;
  }

  private rememberModel(id: string): void {
    this.recentModels = [id, ...this.recentModels.filter((m) => m !== id)].slice(0, 5);
    store.set("rr.recentModels", this.recentModels);
  }

  // ---- messages kept from an earlier connection ------------------------------------------------
  // Read-only unless the person chooses otherwise: nothing here is sent by the app, and a copy only
  // joins this computer's queue after the confirmation (outbox.ts preserved/adopt).

  /** What the sheet shows: other computers' buckets, this computer's held and recovered messages, raw text. */
  private recoveryData(): { candidates: PreservedItem[]; recovered: OutboxEntry[]; held: OutboxEntry[]; raw: string[]; unavailable: boolean } {
    const kept = preserved(rawStorage, this.outboxKey, this.outbox);
    const own = this.outboxKey === null ? null : loadOutbox(rawStorage, this.outboxKey);
    const ownRaw = own !== null && (own.status === "unreadable" || own.status === "partial") ? [own.raw] : [];
    const unavailable = kept.status === "unavailable" || this.outboxNotice === "unavailable" || own?.status === "unavailable";
    return {
      candidates: kept.items,
      recovered: this.outbox.filter((o) => o.delivery === "recovered"),
      held: this.outbox.filter((o) => o.delivery === "held"),
      raw: [...kept.raw, ...ownRaw],
      unavailable,
    };
  }

  /** Keep the home card and an open sheet in step with what is stored. */
  private refreshRecovery(): void {
    const data = this.recoveryData();
    const messages = data.candidates.length + data.recovered.length + data.held.length;
    this.ui.recovery = messages === 0 && data.raw.length === 0 && !data.unavailable ? null : { messages, raw: data.raw.length, unavailable: data.unavailable };
    const sheet = this.ui.sheet;
    if (sheet?.kind !== "recovery") return;
    const present = new Set(data.candidates.map((item) => item.key));
    this.ui.sheet = {
      ...sheet, ...data,
      picked: new Set([...sheet.picked].filter((id) => present.has(id))),
      shown: sheet.shown !== null && sheet.shown < data.raw.length ? sheet.shown : null,
    };
    // The sheet is on screen with these messages: draw it again, or a retry it just handled would
    // keep showing the row the person already acted on.
    this.renderSheet();
  }

  private openRecovery(): void {
    const data = this.recoveryData();
    this.ui.sheet = { kind: "recovery", step: "list", picked: new Set(), shown: null, ...data };
    this.renderSheet();
  }

  private async copyRecovered(id: string): Promise<void> {
    const sheet = this.ui.sheet;
    if (sheet?.kind !== "recovery") return;
    const index = /^raw:(\d+)$/.exec(id);
    // A preserved item is addressed by its opaque handle (two buckets can hold the same id with
    // different words); messages already in this computer's queue are addressed by their id.
    const text = index
      ? sheet.raw[Number(index[1])]
      : [...sheet.held, ...sheet.recovered].find((entry) => entry.clientMsgId === id)?.text
        ?? sheet.candidates.find((item) => item.key === id)?.entry.text;
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Nothing to promise here: say the browser's own name for the refusal rather than a silent tap.
      this.toast(t("error.generic", { text: e instanceof Error && e.name ? e.name : "clipboard" }));
    }
  }

  /** Copy the chosen preserved messages into this computer's queue, once the person confirms. */
  private importRecovered(): void {
    const sheet = this.ui.sheet;
    if (sheet?.kind !== "recovery") return;
    if (sheet.step === "list") {
      if (!sheet.picked.size) return;
      this.ui.sheet = { ...sheet, step: "confirm" };
      this.renderSheet();
      return;
    }
    if (this.outboxKey === null) { this.toast(t("outbox.identityUnknown")); return; }
    const before = this.outbox;
    const picked = sheet.candidates.filter((item) => sheet.picked.has(item.key)).map((item) => item.entry);
    const result = adopt(before, picked);
    if (result.conflicts.length > 0) {
      // The same id is already waiting here with other words: nothing is imported over it, so both
      // texts stay where they are. (A dedicated "conflict" sentence would say more; see the report.)
      this.outbox = before;
      this.toast(t("recovery.importFailed"));
    } else {
      this.outbox = result.entries;
      // The copy is only worth making if this browser keeps it; the originals are untouched either way.
      if (!this.saveOutbox()) { this.outbox = before; this.warnNotSaved(true); }
    }
    this.ui.sheet = { ...sheet, step: "list", picked: new Set() };
    this.refreshRecovery();
    this.renderSheet();
  }

  // ---- rendering -----------------------------------------------------------------------------

  view(id: string): SessionView {
    const c = this.cache(id);
    const out = this.outbox.filter((o) => o.session === id || (id.startsWith("local:") && o.clientMsgId === id.slice(6)) || (o.create && this.created.get(o.clientMsgId) === id));
    const view = reduce(c.events, out, c.events.length > 0 && !c.hasOlder);
    const summary = this.summary(id);
    if (summary?.desktopBridge) view.state = summary.state;
    return view;
  }

  summary(id: string): SessionSummary | undefined {
    const s = this.ui.sessions.find((x) => x.id === id);
    if (s || !id.startsWith("local:")) return s?.origin === "desktop" ? { ...s, readOnly: false } : s;
    const o = this.outbox.find((x) => x.clientMsgId === id.slice(6));
    if (!o?.create) return undefined;
    return { id, title: o.text, cwd: o.create.cwd, model: o.create.model, effort: o.create.effort, state: "starting", pending: 0, createdAt: o.at, updatedAt: o.at, lastSeq: 0, epoch: "" };
  }

  render(): void {
    const root = $("#app");
    const key = this.screen.name === "session" ? `s:${this.screen.id}` : this.screen.name;
    const entering = key !== this.renderedScreen;
    if (entering) {
      this.clearImages();
      this.renderedScreen = key;
      // A conversation opens where the reader left it; one they never opened opens at its newest words.
      const saved = this.screen.name === "session" ? this.cache(this.screen.id).scroll : null;
      this.pinned = saved === null || saved === "bottom";
      this.composerMode = "";
      root.dataset.screen = this.screen.name;
      root.innerHTML = this.screen.name === "pair"
        ? `<main class="scroll">${V.pairScreen()}</main>`
        : `<header class="top" id="top"></header><div id="pre"></div><main class="scroll" id="main">${this.screen.name === "session" ? `<div class="loading-older" id="older" hidden>${t("history.loading")}</div><div class="tl" id="tl"></div>` : ""}</main><footer class="dock"><div id="dock-extra"></div><div id="dock-input"></div></footer><div id="sheet"></div><div id="toast"></div>`;
      this.timelineSize?.disconnect();
      if (this.screen.name === "session") {
        this.timelineSize = new ResizeObserver(() => { if (this.pinned) this.scrollToBottom(); });
        this.timelineSize.observe($("#tl"));
        this.timelineSize.observe($("main"));
        requestAnimationFrame(() => { if (this.pinned) this.scrollToBottom(); });
      }
    }
    if (this.screen.name === "pair") return;
    if (this.screen.name === "home") {
      setHTML($("#top"), V.homeTop(this.ui));
      setHTML($("#pre"), "");
      this.renderHomeMain();
      setHTML($("#dock-extra"), V.chips(this.ui));
      this.renderComposer(t("composer.new"), "send");
    } else {
      this.renderSession();
      // After the list is drawn: the same rows, minus whatever the reader was reading from.
      if (entering) this.place(this.cache(this.screen.id).scroll);
    }
    this.renderSheet();
    this.renderToast();
  }

  /**
   * The home's scrolling region. A rebuild keeps the scroll position, and keeps the caret in the
   * search field: the list changes under a person who is typing, and a lost caret would move their
   * next letter to the wrong place.
   */
  private renderHomeMain(): void {
    const main = $("#main");
    const input = document.getElementById("home-search") as HTMLInputElement | null;
    const typing = input !== null && document.activeElement === input;
    const caret = typing ? input.selectionStart : null;
    const y = main.scrollTop;
    setHTML(main, V.homeMain(this.ui));
    main.scrollTop = y;
    if (!typing) return;
    const again = document.getElementById("home-search") as HTMLInputElement | null;
    again?.focus({ preventScroll: true });
    if (again && caret !== null) again.setSelectionRange(caret, caret);
  }

  /** Only the list changed (a fold, another page, a search letter): the field above it keeps its caret. */
  private renderHomeList(): void {
    setHTML($("#home-list"), V.homeList(this.ui));
  }

  /** Only what changes every second: the link pill, banners, countdowns, "working for". */
  renderChrome(): void {
    if (this.screen.name === "pair") return;
    if (this.screen.name === "home") {
      setHTML($("#top"), V.homeTop(this.ui));
      this.renderHomeMain();
      return;
    }
    this.renderSession(true);
  }

  renderSession(chromeOnly = false): void {
    if (this.screen.name !== "session") return;
    const id = this.screen.id;
    const questions = this.questionState(id);
    this.ui.questionDrafts = questions.drafts; this.ui.deciding = questions.deciding;
    const view = this.view(id);
    const s = this.summary(id);
    const top = $("#top");
    if (!top) return;
    setHTML(top, V.sessionTop(this.ui, s, view));
    setHTML($("#pre"), V.band(this.ui, view) + V.banner(this.ui));
    const perm = s?.readOnly ? "" : V.permCard(view, this.ui);
    const activeInput = document.activeElement as HTMLElement | null;
    const editingQuestion = activeInput?.dataset.questionFree === "true" && !this.ui.deciding?.has(activeInput.dataset.id ?? "") && view.open.some(permission => permission.id === activeInput.dataset.id);
    if (!editingQuestion) setHTML($("#dock-extra"), s?.readOnly ? `<div class="foot">${esc(t("session.readOnly", { host: V.hostName(this.ui) }))}</div>` : perm + (perm ? "" : V.workingLine(view, this.ui, s)) + V.plan(s, this.planOpen) + V.tasks(this.ui, s, this.tasksOpen, timelineItems(view), this.taskSeen.get(id)));
    // Stop only when the host can hear it; offline the button sends (queues) instead.
    const running = view.state === "running" || view.state === "starting" || id.startsWith("local:");
    if (s?.readOnly) {
      setHTML($("#dock-input"), "");
      this.composerMode = "read-only";
    } else this.renderComposer(t("composer.reply"), running && !perm && this.ui.link.state === "open" ? "stop" : "send");
    const openId = view.open[0]?.id ?? "";
    if (openId && openId !== this.lastOpenPerm) navigator.vibrate?.(30);
    this.lastOpenPerm = openId;
    if (chromeOnly) return;
    const main = $("main");
    const stick = this.pinned;
    patchList<TimelineItem>($("#tl"), timelineItems(view), (it) => V.item(it, this.ui));
    this.hydrateImages($("#tl"), id);
    this.renderOlderEdge(this.cache(id));
    if (stick) this.scrollToBottom();
  }

  /** The edge of the loaded history: the page on its way, or its failure with the reader's own retry. */
  private renderOlderEdge(c: Cache): void {
    const el = $("#older");
    if (!el) return;
    el.hidden = !c.loadingOlder && !c.olderFailed;
    el.className = c.olderFailed ? "loading-older failed" : "loading-older";
    setHTML(el, c.loadingOlder ? esc(t("history.loading"))
      : c.olderFailed ? `<span role="alert">${esc(t("history.failed"))}</span><button class="btn ghost" data-act="older">${esc(t("conn.retryNow"))}</button>` : "");
  }

  /** Ask for the conversation's previous page. One at a time; a failed page waits for the person. */
  loadOlder(retry = false): void {
    if (this.screen.name !== "session" || this.ui.sheet !== null) return;
    const c = this.cache(this.screen.id);
    if (!c.hasOlder || c.loadingOlder || !c.events.length || (c.olderFailed && !retry)) return;
    if (this.ui.link.state !== "open") return;
    const reqId = uid(), beforeSeq = c.events[0]!.seq, epoch = c.epoch;
    if (!this.link?.send({ t: "history", session: this.screen.id, beforeSeq, reqId, ...(epoch !== null ? { epoch } : {}) })) return;
    c.loadingOlder = true;
    c.olderFailed = false;
    c.olderReq = reqId;
    c.olderEpoch = epoch;
    c.olderCursor = beforeSeq;
    // A host that never answers must not leave the edge spinning for the rest of the visit.
    c.olderTimer = setTimeout(() => this.failOlder(reqId), 12_000);
    this.renderSession();
  }

  private cancelOlder(c: Cache): void {
    if (c.olderTimer !== null) clearTimeout(c.olderTimer);
    c.olderTimer = null;
    c.loadingOlder = false;
    c.olderReq = null;
    c.olderEpoch = null;
    c.olderCursor = null;
    c.olderFailed = false;
  }

  private failOlder(reqId: string | null): void {
    if (reqId === null) return;
    for (const [id, c] of this.caches) {
      if (c.olderReq !== reqId) continue;
      this.cancelOlder(c);
      c.olderFailed = true;
      if (this.isCurrent(id)) this.renderSession();
      return;
    }
  }

  /**
   * The row at the top edge of the screen and how far its start sits below that edge. A row that
   * starts above the edge (the reader is partway through it) gives a negative inset, so the same
   * arithmetic puts it back where it was.
   */
  private topRow(): { key: string; inset: number } | null {
    const main = $("main"), tl = $("#tl");
    if (!main || !tl) return null;
    const top = main.getBoundingClientRect().top;
    let above: HTMLElement | null = null, below: HTMLElement | null = null;
    for (const row of Array.from(tl.children) as HTMLElement[]) {
      if (!row.dataset.key) continue;
      const box = row.getBoundingClientRect();
      if (box.bottom <= top) continue;                                   // entirely above the edge
      if (box.top <= top) { if (!above || box.top > above.getBoundingClientRect().top) above = row; }
      else if (!below || box.top < below.getBoundingClientRect().top) below = row;
    }
    const row = above ?? below;
    return row ? { key: row.dataset.key!, inset: row.getBoundingClientRect().top - top } : null;
  }

  /** Put the named row back at the same distance below the top edge, whatever moved around it. */
  private place(position: Position | null): void {
    const main = $("main");
    if (!main || position === null) return;
    if (position === "bottom") { this.scrollToBottom(); return; }
    const row = Array.from($("#tl")?.children ?? []).find(child => (child as HTMLElement).dataset.key === position.key) as HTMLElement | undefined;
    // The row the reader was on is gone (the conversation was cleared, or the host rebuilt it):
    // start again from the newest words rather than from the top of whatever is loaded.
    if (!row) { this.pinned = true; this.scrollToBottom(); return; }
    // Where the row sits in the content, then where the scroll has to be for its start to return to
    // the distance the reader left it at. Read off the layout as it is now, not as it was.
    const at = row.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    main.scrollTop = Math.max(0, at - position.inset);
  }

  /** Where the reader is in the conversation being left, for when they come back to it. */
  private rememberPosition(): void {
    if (this.screen.name !== "session") return;
    const main = $("main");
    if (!main) return;
    const atEnd = this.pinned || main.scrollHeight - main.scrollTop - main.clientHeight < 80;
    this.cache(this.screen.id).scroll = atEnd ? "bottom" : this.topRow();
  }

  private renderComposer(placeholder: string, mode: "send" | "stop"): void {
    const key = `${placeholder}|${mode}`;
    const host = $("#dock-input");
    if (!host || key === this.composerMode) return;
    const prev = (document.getElementById("input") as HTMLTextAreaElement | null)?.value ?? store.get<string>(`rr.typed.${this.renderedScreen}`, "");
    host.innerHTML = V.composer(placeholder, mode, prev);
    this.composerMode = key;
    this.fitInput();
  }

  renderSheet(preservePosition = true): void {
    const frame = this.ui.sheet?.kind === "worker" ? this.ui.sheet : null;
    const diff = this.ui.sheet?.kind === "diff" ? this.ui.sheet : null;
    if (frame && preservePosition) this.rememberWorkerPosition();
    if (diff && preservePosition) this.rememberDiffPosition();
    const html = V.sheet(this.ui);
    // A session that left the list takes its own menu with it, rather than reopening it later.
    if (!html && this.ui.sheet?.kind === "session") this.ui.sheet = null;
    setHTML($("#sheet"), html);
    const body = document.getElementById("worker-body");
    if (body && frame) body.scrollTop = frame.scroll;
    // The diff pane is redrawn whole, so its two readings are put back by hand: the file list's own
    // place, and the file's line when one is open on top of it.
    const changes = document.getElementById("diff-body");
    if (changes && diff) changes.scrollTop = diff.open === null ? diff.scroll : this.diffOffsets.get(this.diffKey(diff.open)) ?? 0;
  }

  private diffKey(path: string): string {
    return `${this.screen.name === "session" ? this.screen.id : ""}:${path}`;
  }

  private rememberDiffPosition(): void {
    const sheet = this.ui.sheet;
    if (sheet?.kind !== "diff") return;
    const body = document.getElementById("diff-body");
    if (!body) return;
    if (sheet.open === null) sheet.scroll = body.scrollTop;
    else this.diffOffsets.set(this.diffKey(sheet.open), body.scrollTop);
  }

  /** The session folder's changes, as the host reads them; the phone names only the session. */
  private async openDiff(scope: DiffScope = "auto"): Promise<void> {
    if (this.screen.name !== "session") return;
    const session = this.screen.id;
    if (session.startsWith("local:")) return;
    const before = this.ui.sheet;
    const sheet = before?.kind === "diff" ? before : { kind: "diff" as const, view: null, scope: "auto" as DiffScope, loading: true, error: "", open: null, scroll: 0 };
    // The list shows its last answer while a new one arrives: a spinner over an empty pane would
    // lose the person's place for a comparison they did not ask to leave.
    this.ui.sheet = { ...sheet, scope, loading: true, error: "" };
    this.renderSheet(false);
    try {
      const view = await this.req<DiffView>({ op: "diff", session, ...(scope === "auto" ? {} : { scope }) });
      if (this.screen.name !== "session" || this.screen.id !== session || this.ui.sheet?.kind !== "diff") return;
      this.ui.sheet = { ...this.ui.sheet, view, loading: false, error: "" };
    } catch (error) {
      if (this.screen.name !== "session" || this.screen.id !== session || this.ui.sheet?.kind !== "diff") return;
      this.ui.sheet = { ...this.ui.sheet, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.renderSheet(false);
  }

  /** Text the host moved out of an event (INLINE_CAP): read it back whole, page by page. */
  private async readBlob(session: string, id: string): Promise<string> {
    let offset = 0, text = "";
    for (;;) {
      const chunk = await this.req<BlobChunk>({ op: "blob", session, id, offset });
      text += chunk.text;
      if (chunk.next === null) return text;
      offset = chunk.next;
    }
  }

  /** The whole answer behind a copy button, even when only its preview is in this page's memory. */
  private async copyAnswer(key: string): Promise<void> {
    if (this.screen.name !== "session") return;
    const session = this.screen.id;
    const item = timelineItems(this.view(session)).find(entry => entry.key === key);
    if (item?.type !== "assistant") return;
    try {
      const text = typeof item.text === "string" ? item.text : await this.readBlob(session, item.text.blob);
      await navigator.clipboard.writeText(text);
    } catch (e) {
      this.toast(t("error.generic", { text: e instanceof Error && e.name ? e.name : "clipboard" }));
    }
  }

  private async copyDiff(path: string): Promise<void> {
    const sheet = this.ui.sheet;
    const file = sheet?.kind === "diff" ? sheet.view?.files.find(entry => entry.path === path) : undefined;
    if (!file) return;
    try {
      await navigator.clipboard.writeText(V.patchLines(file.patch).join("\n"));
    } catch (e) {
      // The browser's own refusal is named instead of claiming a copy that did not happen.
      this.toast(t("error.generic", { text: e instanceof Error && e.name ? e.name : "clipboard" }));
    }
  }

  private rememberWorkerPosition(): void {
    const current = this.workerPath.at(-1);
    const body = document.getElementById("worker-body");
    if (current && body?.dataset.sub === current.worker.sub) current.scroll = body.scrollTop;
  }

  private workerBack(): void {
    this.rememberWorkerPosition();
    const closed = this.workerPath.pop();
    this.ui.sheet = this.workerPath.at(-1) ?? null;
    // The old DOM still belongs to the child, not to the newly selected parent.
    setHTML($("#sheet"), "");
    this.renderSheet(false);
    this.focusWorkerLink(closed?.worker.sub);
  }

  private focusWorkerLink(sub?: string): void {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-act=sub]"));
    const target = sub ? buttons.find(button => button.dataset.id === sub) : buttons.find(button => button.closest("#sheet"));
    (target ?? $("#sheet").querySelector<HTMLButtonElement>("button[data-act=worker-back], button[data-act=close-sheet]"))?.focus({ preventScroll: true });
  }

  private renderToast(): void {
    const el = $("#toast");
    if (el) el.innerHTML = this.ui.toast ? `<div class="toast" role="status">${this.ui.toast.replace(/[<>&]/g, "")}</div>` : "";
  }

  toast(text: string): void {
    this.ui.toast = text;
    this.renderToast();
    setTimeout(() => { if (this.ui.toast === text) { this.ui.toast = null; this.renderToast(); } }, 3500);
  }

  scrollToBottom(): void {
    const main = $("main");
    if (main) main.scrollTop = main.scrollHeight;
  }

  private fitInput(): void {
    const ta = document.getElementById("input") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    const send = ta.parentElement?.querySelector<HTMLButtonElement>("button[data-act=send]");
    if (send) send.disabled = !ta.value.trim();
  }

  // ---- sheets --------------------------------------------------------------------------------

  async openFolderSheet(): Promise<void> {
    this.ui.sheet = { kind: "folder", recent: [], browse: null, filter: "", loading: true };
    this.renderSheet();
    try {
      const [recent, browse] = await Promise.all([this.req<FolderEntry[]>({ op: "folders" }), this.browseAt(this.ui.draft.cwd ?? undefined)]);
      if (this.ui.sheet?.kind !== "folder") return;
      this.ui.home = browse.home;
      this.ui.sheet = { ...this.ui.sheet, recent, browse, loading: false };
      this.renderSheet();
    } catch (e) { this.toast(t("error.generic", { text: (e as Error).message })); }
  }

  /** Browsing the folder a session last used: if it is gone (moved, renamed, an unplugged drive), the
   * home folder is shown instead of a sheet that never fills. */
  private async browseAt(path: string | undefined): Promise<BrowseResult> {
    try { return await this.req<BrowseResult>({ op: "browse", ...(path ? { path } : {}) }); }
    catch (error) { if (!path) throw error; return this.req<BrowseResult>({ op: "browse" }); }
  }

  async browse(path: string): Promise<void> {
    try {
      const browse = await this.req<BrowseResult>({ op: "browse", path });
      if (this.ui.sheet?.kind !== "folder") return;
      this.ui.sheet = { ...this.ui.sheet, browse, filter: "", pathDraft: browse.path };
      this.renderSheet();
    } catch { this.toast(t("error.cwd")); }
  }

  /**
   * Go to a path typed into the folder sheet. The host opens it the way it opens any browse — a
   * missing folder or a file comes back as an error, which is what the field reports; nothing is
   * invented on this side.
   */
  async browseTyped(typed: string): Promise<void> {
    try {
      const browse = await this.req<BrowseResult>({ op: "browse", ...(typed.trim() ? { path: typed.trim() } : {}) });
      if (this.ui.sheet?.kind !== "folder") return;
      this.ui.sheet = { ...this.ui.sheet, browse, filter: "", pathDraft: browse.path };
      this.renderSheet();
    } catch { this.toast(t("folder.pathFailed")); }
  }

  openModelSheet(forSession: string | null): void {
    const s = forSession ? this.summary(forSession) : undefined;
    if (s?.readOnly) return;
    const v = forSession ? this.view(forSession) : null;
    const model = (v?.model ?? s?.model) ?? this.ui.draft.model;
    const effort = (v?.effort ?? s?.effort) ?? this.ui.draft.effort;
    // Auto is host-wide: the sheet opens on it when the Mac has it on. A host that cannot write
    // mod settings has no Auto option at all, so the choice stays with the model's levels.
    const auto = this.autoWritable() && this.ui.host?.ripple?.effortAuto === true;
    this.ui.sheet = { kind: "model", groups: this.ui.models, recent: this.recentModels, model, effort, forSession, auto };
    this.renderSheet();
    if (!this.ui.models.length) void this.loadModels().then(() => { if (this.ui.sheet?.kind === "model") { this.ui.sheet.groups = this.ui.models; this.renderSheet(); } });
  }

  /** Whether this host can turn the mod's host-wide automatic effort on or off. */
  private autoWritable(): boolean {
    return this.ui.host?.capabilities?.effortAuto === true && !!this.ui.host.ripple;
  }

  private effortsFor(model: string | null): Effort[] {
    return model ? this.ui.models.flatMap((g) => g.models).find((m) => m.model === model)?.efforts ?? [] : [];
  }

  /** A failed Auto write is said plainly; the sheet's other choices still went through. */
  private async setEffortAuto(on: boolean): Promise<void> {
    try { await this.req<{ effortAuto: boolean }>({ op: "effort_auto", on }); }
    catch { this.toast(t("model.autoFailed")); }
  }

  // ---- input -----------------------------------------------------------------------------------

  private editQuestion(id: string, index: number, change: (draft: QuestionDraft, question: Question) => QuestionDraft, redraw = true): void {
    if (this.screen.name !== "session" || this.ui.deciding?.has(id)) return;
    const permission = this.view(this.screen.id).open.find(item => item.id === id && item.requestKind === "question");
    const questions = permission?.questions ?? [], question = questions[index];
    if (!question) return;
    const drafts = this.ui.questionDrafts ??= new Map();
    const draft = change(drafts.get(id) ?? emptyQuestionDraft(), question);
    drafts.set(id, draft);
    if (redraw) { this.renderSession(true); return; }
    const preview = document.getElementById(`question-preview-${id}-${index}`);
    if (preview) preview.textContent = questionAnswers(questions, draft)[question.question] || t("perm.unanswered");
    const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-act="allow"]')).find(button => button.dataset.id === id);
    if (submit) submit.disabled = !questionsComplete(questions, draft);
  }

  private bind(): void {
    const root = $("#app");
    // A row's detail block keeps its own open state in the element; recording it here is what
    // survives the element being replaced (a streaming row) or the conversation being opened again.
    // `toggle` does not bubble, so it is caught on the way down.
    root.addEventListener("toggle", (ev) => {
      const details = ev.target as HTMLDetailsElement;
      const key = details.dataset?.k;
      if (!key) return;
      if (details.open) this.ui.expanded.set(key, null);
      else this.ui.expanded.delete(key);
    }, true);
    root.addEventListener("click", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!el) return;
      void this.act(el.dataset.act!, el);
    });
    root.addEventListener("input", (ev) => {
      const el = ev.target as HTMLElement;
      if (el.id === "input") { this.fitInput(); store.set(`rr.typed.${this.renderedScreen}`, (el as HTMLTextAreaElement).value); }
      if (el.dataset.questionFree === "true") this.editQuestion(el.dataset.id ?? "", Number(el.dataset.index), (draft, question) => freeAnswer(draft, question, (el as HTMLTextAreaElement).value), false);
      // The home search redraws only the list below the field, so the field keeps its caret and a
      // new search starts from its first page.
      if (el.id === "home-search" && this.screen.name === "home") {
        this.ui.query = (el as HTMLInputElement).value;
        this.ui.homeLimit = V.HOME_PAGE;
        this.renderHomeList();
      }
      if (el.id === "folder-filter" && this.ui.sheet?.kind === "folder") {
        this.ui.sheet.filter = (el as HTMLInputElement).value;
        const pos = (el as HTMLInputElement).selectionStart;
        this.renderSheet();
        const again = document.getElementById("folder-filter") as HTMLInputElement | null;
        again?.focus();
        if (again && pos !== null) again.setSelectionRange(pos, pos);
      }
      // The typed path is kept in the sheet, so a redraw from elsewhere does not lose it; the field
      // itself is not redrawn per keystroke.
      if (el.id === "folder-path" && this.ui.sheet?.kind === "folder") this.ui.sheet.pathDraft = (el as HTMLInputElement).value;
    });
    root.addEventListener("keydown", (ev) => {
      const el = ev.target as HTMLElement;
      if (el.dataset.act === "question-option" && el.getAttribute("role") === "radio" && ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(ev.key)) {
        ev.preventDefault();
        let option = Number(el.dataset.option);
        this.editQuestion(el.dataset.id ?? "", Number(el.dataset.index), (draft, question) => {
          option = ev.key === "Home" ? 0 : ev.key === "End" ? question.options.length - 1 : (option + (ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 1) + question.options.length) % question.options.length;
          return toggleOption(draft, question, option);
        });
        Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-act="question-option"]')).find(button => button.dataset.id === el.dataset.id && button.dataset.index === el.dataset.index && Number(button.dataset.option) === option)?.focus({ preventScroll: true });
        return;
      }
      const modal = this.ui.sheet?.kind === "worker" || this.ui.sheet?.kind === "diff";
      if (modal && ev.key === "Escape") {
        ev.preventDefault();
        if (this.workerPath.length > 1) this.workerBack();
        else void this.act("close-sheet", el);
        return;
      }
      if (modal && ev.key === "Tab") {
        const buttons = Array.from($("#sheet").querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
        const first = buttons[0], last = buttons.at(-1);
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
      }
      // Enter sends on a hardware keyboard; on a phone the return key makes a new line unless enterkeyhint says send.
      if (el.id === "input" && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && matchMedia("(pointer: fine)").matches) {
        ev.preventDefault();
        void this.act("send", el);
      }
      if (el.id === "folder-path" && ev.key === "Enter" && !ev.isComposing) {
        ev.preventDefault();
        void this.browseTyped((el as HTMLInputElement).value);
      }
    });
    root.addEventListener("scroll", (ev) => {
      const main = ev.target as HTMLElement;
      if (main.id !== "main" || this.screen.name !== "session") return;
      this.pinned = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
      // Reading up to the oldest loaded page asks for the one before it.
      if (main.scrollTop <= 240) this.loadOlder();
    }, true);
  }

  async act(act: string, el: HTMLElement): Promise<void> {
    const id = el.dataset.id ?? "";
    const session = this.screen.name === "session" ? this.screen.id : "";
    if (session && this.summary(session)?.readOnly && ["send", "retry-send", "stop", "allow", "deny", "always", "pick-model-session"].includes(act)) return;
    switch (act) {
      case "image": {
        const image = el.querySelector('img');
        if (!image?.src || image.hidden) break;
        const viewer = document.createElement('div');
        viewer.className = 'image-viewer'; viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true');
        const close = document.createElement('button'); close.textContent = t('a11y.close');
        const full = document.createElement('img'); full.src = image.src; full.alt = t('image.view');
        viewer.append(close, full); $("#app").append(viewer);
        const dismiss = () => { viewer.remove(); document.removeEventListener('keydown', key); el.focus(); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
        close.onclick = dismiss; document.addEventListener('keydown', key); close.focus();
        break;
      }
      case "retry": this.link?.nudge(); break;
      case "older": this.loadOlder(true); break;
      case "retry-send": {
        // Through the existing queue path: back to pending, then the same flush a reconnect uses.
        // This is the person's own retry, so it goes out even from a queue the browser is not keeping.
        const before = this.outbox;
        this.outbox = requeue(this.outbox, id);
        if (this.outbox === before) break;
        // An explicit retry sends that one message; if the queue cannot be kept, it is not sent at all.
        if (!this.saveOutbox()) { this.outbox = before; this.warnNotSaved(true); break; }
        this.flushOutbox([id]);
        this.refreshRecovery();
        break;
      }
      case "edit-send": {
        // The words go back into the composer — the one place a message is changed — so there is a
        // single copy of them. A held message is not changed here: its outcome (or an already-made
        // session) is unknown, and the person is told why instead of being silently ignored.
        const entry = this.outbox.find((o) => o.clientMsgId === id);
        if (!entry || entry.error === undefined) break;
        if (entry.state === "sending" || (entry.delivery ?? "queued") !== "queued") { this.toast(t("outbox.waiting")); break; }
        const ta = document.getElementById("input") as HTMLTextAreaElement | null;
        if (!ta || ta.value.trim()) break;   // a draft already being written is never replaced
        // The message moves into the composer only once its words are safely in the stored draft: a
        // draft write that fails leaves the message exactly where it is, still on disk and on screen.
        try {
          rawStorage.setItem(`rr.typed.${this.renderedScreen}`, JSON.stringify(entry.text));
        } catch {
          this.warnNotSaved(true);
          break;
        }
        ta.value = entry.text;
        this.fitInput();
        // A refused send is handed back whole: its words now live in the composer. A create keeps its
        // entry, because that entry is what names this screen; sending from here reuses its id.
        if (entry.session !== null) this.dropOutbox(entry.clientMsgId);
        ta.focus();
        break;
      }
      case "recovery-open": this.openRecovery(); break;
      case "recovery-pick": {
        const sheet = this.ui.sheet;
        if (sheet?.kind !== "recovery") break;
        if (sheet.picked.has(id)) sheet.picked.delete(id); else sheet.picked.add(id);
        this.renderSheet();
        break;
      }
      case "recovery-raw": {
        const sheet = this.ui.sheet;
        if (sheet?.kind !== "recovery") break;
        const index = Number(id);
        this.ui.sheet = { ...sheet, shown: sheet.shown === index ? null : Number.isFinite(index) ? index : null };
        this.renderSheet();
        break;
      }
      case "recovery-copy": await this.copyRecovered(id); break;
      case "recovery-import": this.importRecovered(); break;
      case "recovery-send": {
        // The person sends a message they imported: same id, so the host cannot run it twice. Only a
        // create can be sent from here — a plain message belonged to another computer's session, and
        // has no session on this one to go to.
        if (!this.outbox.some((o) => o.clientMsgId === id && o.delivery === "recovered" && o.create)) break;
        const before = this.outbox;
        this.outbox = requeue(this.outbox, id);
        if (!this.saveOutbox()) { this.outbox = before; this.warnNotSaved(true); break; }
        this.flushOutbox([id]);
        this.refreshRecovery();
        break;
      }
      case "pair-link": {
        // A Home Screen app keeps its own storage, apart from Safari's: the pairing a scanned QR
        // left in Safari never reaches it, so the link is pasted here instead.
        const value = (document.getElementById("pair-link") as HTMLInputElement | null)?.value ?? "";
        if (savePairing(value.slice(value.indexOf("#")))) location.reload();
        else this.toast(t("pair.badLink"));
        break;
      }
      case "home": this.go({ name: "home" }); break;
      case "open": this.go({ name: "session", id }); break;
      case "fold": {
        // Section names are the handles, so a fold survives a relaunch and a language change.
        const key = el.dataset.key ?? "";
        if (!key) break;
        const folded = this.ui.folded;
        this.ui.folded = folded.includes(key) ? folded.filter(name => name !== key) : [...folded, key];
        store.set("rr.folded", this.ui.folded);
        this.renderHomeList();
        break;
      }
      case "home-more": this.ui.homeLimit += V.HOME_PAGE; this.renderHomeList(); break;
      case "row-menu": {
        if (!this.ui.sessions.some(s => s.id === id)) break;
        this.ui.sheet = { kind: "session", id };
        this.renderSheet();
        break;
      }
      case "pin-toggle": {
        // A pin is this device's own note about the list; nothing is sent to the computer.
        if (!this.ui.sessions.some(s => s.id === id)) break;
        const pins = this.ui.pins;
        this.ui.pins = pins.includes(id) ? pins.filter(pin => pin !== id) : [...pins, id];
        store.set("rr.pins", this.ui.pins);
        this.ui.sheet = null;
        this.render();
        break;
      }
      case "archive-toggle": {
        const target = this.ui.sessions.find(s => s.id === id);
        if (!target) break;
        if (!this.link?.send({ t: "archive", session: id, archived: !target.archived })) { this.toast(t("home.needsHost")); break; }
        this.ui.sheet = null;
        this.renderSheet();
        break;
      }
      case "unread": {
        if (!this.link?.send({ t: "unread", session: id })) { this.toast(t("home.needsHost")); break; }
        this.ui.sheet = null;
        this.renderSheet();
        break;
      }
      case "toggle-tasks": this.tasksOpen = !this.tasksOpen; this.renderSession(true); break;
      case "plan-toggle": this.planOpen = !this.planOpen; this.renderSession(true); break;
      case "question-jump":
      case "question-option": {
        const index = Number(el.dataset.index), option = Number(el.dataset.option);
        this.editQuestion(id, index, (draft, question) => act === "question-jump" ? { ...draft, current: index } : toggleOption(draft, question, option));
        Array.from(document.querySelectorAll<HTMLButtonElement>(`button[data-act="${act}"]`)).find(button => button.dataset.id === id && Number(button.dataset.index) === index && (act === "question-jump" || Number(button.dataset.option) === option))?.focus({ preventScroll: true });
        break;
      }
      case "task-read": {
        const seen = this.taskSeen.get(session) ?? new Set<string>();
        seen.add(id); this.taskSeen.set(session, seen);
        if (el.dataset.sub) await this.openSub(el.dataset.sub);
        this.renderSession(true);
        break;
      }
      case "send": {
        const ta = document.getElementById("input") as HTMLTextAreaElement | null;
        if (!ta) return;
        // The field is cleared only once the message is actually queued: a send that is refused a
        // started session, or one that waits for the person, leaves their words where they are.
        if (!this.submit(ta.value)) return;
        ta.value = "";
        store.set(`rr.typed.${this.renderedScreen}`, "");
        this.fitInput();
        break;
      }
      case "stop": if (session && !session.startsWith("local:")) this.link?.send({ t: "interrupt", session }); break;
      case "allow": case "deny": case "always":
        if (session) {
          const decision = act === "always" ? "allow_always" : act;
          const permission = reduce(this.cache(session).events).open.find(p => p.id === id);
          if (!permission) return;
          if (permission.requestKind === "question") {
            const deciding = this.ui.deciding ??= new Set();
            if (deciding.has(id) || decision === "allow_always") return;
            const draft = this.ui.questionDrafts?.get(id) ?? emptyQuestionDraft();
            if (decision !== "deny" && !questionsComplete(permission.questions ?? [], draft)) return;
            const answers = questionAnswers(permission.questions ?? [], draft);
            deciding.add(id); this.renderSession(true);
            try { await this.requestFrame(reqId => ({ t: "decide", reqId, session, id, decision, ...(decision !== "deny" ? { answers } : {}) })); }
            catch (error) {
              if (deciding.has(id)) {
                const unknown = error instanceof Error && error.message === "timeout";
                if (!unknown) deciding.delete(id);
                this.toast(unknown ? t("perm.unconfirmed") : t("error.generic", { text: error instanceof Error ? error.message : String(error) }));
              }
              if (this.isCurrent(session)) this.renderSession(true);
            }
          } else if (!this.link?.send({ t: "decide", session, id, decision })) this.toast(t("queue.pending"));
        }
        break;
      case "perm-more": this.ui.permOpen.add(id); this.renderSession(true); break;
      case "workers": this.ui.workersOpen = !this.ui.workersOpen; this.renderSession(true); break;
      case "diff": await this.openDiff(); break;
      case "diff-scope": {
        const sheet = this.ui.sheet;
        if (sheet?.kind !== "diff") break;
        // A different comparison is a different question, so its list starts at the top.
        this.ui.sheet = { ...sheet, open: null, scroll: 0 };
        await this.openDiff((el.dataset.scope as DiffScope) ?? "uncommitted");
        break;
      }
      case "diff-file": {
        const sheet = this.ui.sheet;
        // Only a file with a patch is a way in: a binary has nothing to read.
        if (sheet?.kind !== "diff" || !sheet.view?.files.some(entry => entry.path === id && entry.patch)) break;
        // The list's place is kept, then the file draws over it from where it was last read.
        this.rememberDiffPosition();
        this.ui.sheet = { ...sheet, open: id };
        this.renderSheet(false);
        break;
      }
      case "diff-back": {
        const sheet = this.ui.sheet;
        if (sheet?.kind !== "diff") break;
        this.rememberDiffPosition();
        this.ui.sheet = { ...sheet, open: null };
        this.renderSheet(false);
        break;
      }
      case "diff-step": {
        const sheet = this.ui.sheet;
        if (sheet?.kind !== "diff" || !sheet.view || sheet.open === null) break;
        const next = sheet.view.files[Number(el.dataset.index)];
        if (!next || !next.patch) break;
        this.rememberDiffPosition();
        this.ui.sheet = { ...sheet, open: next.path };
        this.renderSheet(false);
        break;
      }
      case "diff-copy": await this.copyDiff(id); break;
      case "diff-retry": if (this.ui.sheet?.kind === "diff") await this.openDiff(this.ui.sheet.scope); break;
      case "tool-group": {
        const expanded = this.ui.sheet?.kind === "worker" ? this.ui.sheet.expanded : this.ui.expanded;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.set(id, null);
        this.rerenderItems();
        break;
      }
      case "tool": await this.toggleTool(id); break;
      case "copy-answer": await this.copyAnswer(el.dataset.key ?? id); break;
      case "sub": await this.openSub(id); break;
      case "worker-back": this.workerBack(); break;
      case "worker-retry": if (this.ui.sheet?.kind === "worker") await this.loadWorker(this.ui.sheet, session); break;
      case "pick-folder": await this.openFolderSheet(); break;
      case "pick-model": this.openModelSheet(null); break;
      case "pick-model-session": if (session && !session.startsWith("local:")) this.openModelSheet(session); break;
      case "close-sheet": {
        const sub = this.workerPath[0]?.worker.sub;
        const wasDiff = this.ui.sheet?.kind === "diff";
        this.workerPath = []; this.ui.sheet = null; this.renderSheet();
        if (sub) this.focusWorkerLink(sub);
        // Back where the sheet was opened from, as a keyboard user expects.
        if (wasDiff) document.querySelector<HTMLButtonElement>("button[data-act=diff]")?.focus({ preventScroll: true });
        break;
      }
      case "browse": await this.browse(el.dataset.path ?? ""); break;
      case "browse-path": {
        const input = document.getElementById("folder-path") as HTMLInputElement | null;
        await this.browseTyped(input?.value ?? "");
        break;
      }
      case "choose-folder":
        this.ui.draft.cwd = el.dataset.path ?? null;
        store.set("rr.draft", this.ui.draft);
        this.ui.sheet = null;
        this.render();
        break;
      case "choose-model": if (this.ui.sheet?.kind === "model") {
        const m = this.ui.models.flatMap((g) => g.models).find((x) => x.model === el.dataset.model);
        this.ui.sheet.model = m?.model ?? null;
        if (m) { const saved = store.get<Effort | null>(`rr.effort.${m.model}`, null); this.ui.sheet.effort = saved && m.efforts.includes(saved) ? saved : defaultEffort(m.efforts); }
        if (m && !m.efforts.length) this.ui.sheet.effort = null;
        this.renderSheet();
      } break;
      case "choose-effort": if (this.ui.sheet?.kind === "model") { this.ui.sheet.effort = (el.dataset.effort as Effort) ?? null; this.ui.sheet.auto = false; this.renderSheet(); } break;
      case "choose-auto": if (this.ui.sheet?.kind === "model") { this.ui.sheet.auto = true; this.renderSheet(); } break;
      case "model-done": if (this.ui.sheet?.kind === "model" && this.ui.sheet.model) {
        const { model, effort, forSession, auto } = this.ui.sheet;
        const autoShown = this.autoWritable() && this.effortsFor(model).length > 0;
        const autoSelected = autoShown && auto === true;
        const currentModel = forSession ? (this.view(forSession)?.model ?? this.summary(forSession)?.model ?? null) : null;
        if (autoSelected) {
          // A new model under Auto starts on the level the sheet gave it (its remembered or default
          // one), which the new model surely has; the mod takes over from the next prompt.
          if (forSession && currentModel !== model) this.link?.send({ t: "set_model", session: forSession, model, effort });
          if (autoShown && this.ui.host?.ripple?.effortAuto !== true) void this.setEffortAuto(true);
          if (!forSession) { this.ui.draft.model = model; store.set("rr.draft", this.ui.draft); }
          this.rememberModel(model);
        } else {
          if (forSession) this.link?.send({ t: "set_model", session: forSession, model, effort });
          else { this.ui.draft.model = model; this.ui.draft.effort = effort; store.set("rr.draft", this.ui.draft); }
          // A level means manual from now on, host-wide, not only in this session.
          if (autoShown && this.ui.host?.ripple?.effortAuto === true) void this.setEffortAuto(false);
          this.rememberModel(model);
          store.set(`rr.effort.${model}`, effort);
        }
        this.ui.sheet = null;
        this.render();
      } break;
      case "settings": this.toggleLang(); break;
      // No await before this: the permission prompt has to come from the tap itself.
      case "push-on": await this.turnOnPush(); break;
      case "push-later": store.set("rr.pushLater", true); this.ui.pushLater = true; this.render(); break;
    }
  }

  private toggleLang(): void {
    const next = (store.get<string | null>("rr.lang", null) ?? (document.documentElement.lang || "ko")) === "ko" ? "en" : "ko";
    store.set("rr.lang", next);
    setLang(next);
    document.documentElement.lang = next;
    this.renderedScreen = "";
    this.render();
  }

  private async toggleTool(id: string): Promise<void> {
    const frame = this.ui.sheet?.kind === "worker" ? this.ui.sheet : null;
    const expanded = frame?.expanded ?? this.ui.expanded;
    if (expanded.has(id)) { expanded.delete(id); this.rerenderItems(); return; }
    expanded.set(id, null);
    this.rerenderItems();
    if (this.screen.name !== "session") return;
    const items = frame?.items ?? timelineItems(this.view(this.screen.id));
    const permission = items.find((item): item is Extract<TimelineItem, { type: "permission" }> => item.type === "permission" && item.id === id && item.requestKind === "plan" && item.decision !== null);
    const tool: import("./timeline.ts").ToolView | undefined = items.flatMap(i => i.type === "toolGroup" ? i.rows.flatMap(row => row.type === "tool" ? [row.tool] : row.call ? [row.call] : []) : i.type === "assistant" ? i.tools : []).find(x => x.id === id) ?? (permission ? { id, name: permission.tool, summary: permission.summary, input: permission.input } : undefined);
    const session = this.screen.id;
    const values = [tool?.input, tool?.result?.text].filter((v) => v !== undefined);
    if (!values.some(v => typeof v !== "string")) return;
    try {
      const parts: string[] = [];
      for (const value of values) {
        if (typeof value === "string") { parts.push(value); continue; }
        let offset = 0, text = "";
        for (;;) {
          const chunk = await this.req<BlobChunk>({ op: "blob", session, id: value.blob, offset });
          text += chunk.text;
          if (chunk.next === null) break;
          offset = chunk.next;
        }
        parts.push(text);
      }
      if (expanded.has(id)) expanded.set(id, parts.filter(Boolean).join("\n\n────\n\n"));
    } catch (e) { this.toast(t("error.generic", { text: (e as Error).message })); }
    if (this.isCurrent(session)) this.rerenderItems();
  }

  private rerenderItems(): void {
    if (this.ui.sheet?.kind === "worker") { this.renderSheet(); return; }
    // Expanded state is UI-only; bump versions by re-rendering the list wholesale.
    const tl = document.getElementById("tl");
    if (tl) for (const child of Array.from(tl.children) as HTMLElement[]) child.dataset.ver = "";
    this.renderSession();
  }

  private async openSub(sub: string): Promise<void> {
    if (this.screen.name !== "session") return;
    const parent = this.ui.sheet?.kind === "worker" ? this.ui.sheet : null;
    if (!parent) this.workerPath = [];
    // Cyclic or repeated links return to their existing frame rather than stacking forever.
    const existing = this.workerPath.findIndex(frame => frame.worker.sub === sub);
    this.rememberWorkerPosition();
    if (existing >= 0) {
      this.workerPath = this.workerPath.slice(0, existing + 1);
      this.ui.sheet = this.workerPath.at(-1)!;
      this.renderSheet();
      return;
    }
    const items = parent?.items ?? timelineItems(this.view(this.screen.id));
    const summary = this.summary(this.screen.id);
    const task = [...(summary?.taskList ?? []), ...(summary?.taskHistory ?? [])].find(task => task.sub === sub);
    const frame: V.WorkerSheet = { kind: "worker", worker: workerFor(items, sub, task?.label ?? t("sub.worker"), task?.state === "unknown" ? undefined : task?.state), items: [], loading: false, error: "", depth: this.workerPath.length + 1, scroll: 0, expanded: new Map() };
    this.workerPath.push(frame);
    this.ui.sheet = frame;
    const loading = this.loadWorker(frame, this.screen.id);
    this.focusWorkerLink();
    await loading;
    if (this.ui.sheet === frame) this.focusWorkerLink();
  }

  private async loadWorker(frame: V.WorkerSheet, session: string): Promise<void> {
    if (frame.loading) return;
    frame.loading = true; frame.error = "";
    this.renderSheet();
    const current = () => this.isCurrent(session) && this.workerPath.includes(frame);
    const draw = () => { if (current() && this.ui.sheet === frame) { this.renderSheet(); this.hydrateImages($("#sheet"), session); } };
    try {
      let prompt = frame.prompt;
      if (prompt === undefined) {
        let input = frame.worker.call?.input ?? "";
        if (typeof input !== "string") {
          let offset = 0, full = "";
          for (;;) {
            const chunk = await this.req<BlobChunk>({ op: "blob", session, id: input.blob, offset });
            if (!current()) return;
            full += chunk.text;
            if (chunk.next === null) break;
            offset = chunk.next;
          }
          input = full;
        }
        prompt = frame.prompt = workerPrompt(input);
      }
      // Only what the worker wrote since the last read: a long log is fetched once and then grows by
      // the steps that are new, and each page is drawn as it lands.
      let afterSeq = frame.afterSeq ?? 0;
      for (;;) {
        const page = await this.req<SubPage>({ op: "sub", session, sub: frame.worker.sub, afterSeq });
        if (!current()) return;
        if (page.events.length) {
          frame.events = mergeEvents(frame.events ?? [], page.events);
          frame.items = workerConversationItems(frame.events, prompt);
          frame.afterSeq = frame.events.at(-1)?.seq ?? afterSeq;
          draw();
        }
        if (!page.more || !page.events.length) break;
        const next = page.events.at(-1)?.seq ?? 0;
        if (next <= afterSeq) throw new Error(t("tool.failed"));
        afterSeq = next;
      }
      frame.seen = frame.worker.ver;
    } catch (error) { if (current()) frame.error = error instanceof Error ? error.message : String(error); }
    finally { frame.loading = false; draw(); }
  }

  /**
   * A worker's conversation follows its steps while it runs: the sheet asks only for what happened
   * after the last step it holds, so a long log is not read again for every new one.
   */
  private followWorker(session: string): void {
    const frame = this.ui.sheet?.kind === "worker" ? this.ui.sheet : null;
    if (!frame || !this.isCurrent(session) || frame.loading) return;
    const items = timelineItems(this.view(session));
    // Only a worker the session itself launched can be followed; a nested one is drawn from its own
    // parent's log, which is read again in its own frame.
    const launched = items.some(item => item.type === "subagent" && item.sub === frame.worker.sub
      || item.type === "toolGroup" && item.rows.some(row => row.type === "subagent" && row.sub === frame.worker.sub));
    if (!launched) return;
    const worker = workerFor(items, frame.worker.sub, t("sub.worker"));
    if (worker.ver === frame.seen && worker.status === frame.worker.status) return;
    frame.worker = worker;
    void this.loadWorker(frame, session);
  }
}

export function boot(): void {
  const lang = pickLang(navigator.languages ?? [navigator.language], store.get<string | null>("rr.lang", null));
  setLang(lang);
  document.documentElement.lang = lang;
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  if (demo) { void import("./demo.ts").then((d) => d.runDemo(demo, params)); return; }
  // start() is async only for the pairing fingerprint; a failure there is left to the console, not swallowed.
  void new App({ state: "connecting", attempt: 0, nextAt: null, lastRx: null, downSince: null }).start();
}

boot();
