// Web push to the phone (RFC 8030 delivery, RFC 8291 payload encryption, RFC 8292 VAPID, via the
// `web-push` package). Four moments, and only when no connected phone looked at that session in
// the last SEEN_MS (180 s): a permission request is waiting, a turn finished, a turn failed, and a
// Claude app turn that closed on a question the person must answer.
// They arrive as an appended event, or as a Mac-session alert (Sessions.onAlert) for a session the
// host is not tailing. Tapping the push opens exactly that session (its id is in the payload's
// session field). The payload is the session title and what the turn did (its last reply, the
// approval it waits for, or the question), as in the native push: RFC 8291 encrypts it end to end,
// so the push service never reads it. Without that context it is the title plus fixed state words.
//
// The VAPID key pair is made once and kept under the host's config dir (0600); a new pair would
// orphan every subscription. Subscriptions are per device (the phone's clientId) and a push
// service answering 404/410 means the subscription is gone for good, so it is dropped.
import path from "node:path";
import webpush from "web-push";
import { SLOW_PING_MS } from "./protocol.ts";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { pushContent, type PushContext } from "./push-content.ts";
import type { PushEvent, PushSubscriptionJSON, SessionSummary } from "./protocol.ts";

export const VISIBLE_MS = 30_000;
/** A client on the slow cadence (a presence report every SLOW_PING_MS) stays visible for three
 * missed reports, as a fast client does at VISIBLE_MS. */
export const SLOW_VISIBLE_MS = 3 * SLOW_PING_MS;
/** A session a connected phone looked at within this needs no push (Paseo agent-attention-policy PRESENCE_THRESHOLD_MS). */
export const SEEN_MS = 180_000;

export interface Vapid { publicKey: string; privateKey: string; subject: string }

export function loadVapid(dir: string, subject: string): Vapid {
  const file = path.join(dir, "vapid.json");
  const stored = readJson<Partial<Vapid>>(file);
  if (stored && typeof stored.publicKey === "string" && typeof stored.privateKey === "string") {
    // The subject may change (the https address became known); the keys never do.
    return { publicKey: stored.publicKey, privateKey: stored.privateKey, subject };
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileAtomic(file, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2) + "\n");
  return { ...keys, subject };
}

interface Stored { sub: PushSubscriptionJSON; lang: "ko" | "en"; at: number }

export type Sender = (sub: PushSubscriptionJSON, payload: string, opts: { urgency: "normal" | "high"; ttl: number; topic: string }) => Promise<void>;
/** What a failed send means for the subscription: 404 and 410 say it no longer exists (RFC 8030 §7.3, §8). */
export const isGone = (e: unknown): boolean => {
  const code = (e as { statusCode?: unknown })?.statusCode;
  return code === 404 || code === 410;
};

export function webPushSender(vapid: Vapid): Sender {
  return async (sub, payload, opts) => {
    await webpush.sendNotification(sub, payload, {
      vapidDetails: vapid,
      contentEncoding: "aes128gcm",
      urgency: opts.urgency,
      TTL: opts.ttl,
      topic: opts.topic,
      timeout: 15_000,
    });
  };
}

export interface PushPayload { title: string; body: string; session: string; tag: string }

const COPY = {
  ko: {
    permission: "승인을 기다립니다",
    question: "답변이 필요합니다",
    done: "작업을 마쳤습니다",
    failed: "작업이 실패했습니다",
  },
  en: {
    permission: "Waiting for approval",
    question: "Answer needed",
    done: "Work finished",
    failed: "Work failed",
  },
} as const;

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const folderOf = (cwd: string): string => path.basename(cwd) || cwd;

/** The push for an event or Mac-session alert, or null if it is not one of those moments.
 * The session title plus fixed state words — and for a question, the closing box's `ask`, which is
 * what the person must answer. That is the model's text, so it goes only where the payload is
 * encrypted end to end (this web push, RFC 8291; Expo's `e`): neither Expo/Apple nor the web push
 * service ever reads assistant text, tool input, or error detail. */
export function pushFor(event: PushEvent, s: Pick<SessionSummary, "id" | "title" | "cwd">, lang: "ko" | "en"): PushPayload | null {
  const c = COPY[lang];
  const title = clip(s.title || folderOf(s.cwd), 140);
  if (event.kind === "permission") {
    return { title, body: c.permission, session: s.id, tag: `perm-${s.id}` };
  }
  if (event.kind === "question") {
    return { title, body: `${c.question} · ${clip(event.ask, 160)}`, session: s.id, tag: `ask-${s.id}` };
  }
  if (event.kind === "result" && event.ok) {
    return { title, body: c.done, session: s.id, tag: `turn-${s.id}` };
  }
  if (event.kind === "result" && !event.ok) {
    return { title, body: c.failed, session: s.id, tag: `turn-${s.id}` };
  }
  return null;
}

export interface NotifierOptions {
  dir: string;
  send: Sender;
  /** true while a connected phone looked at this session in the last SEEN_MS */
  seenRecently: (session: string) => boolean;
  summary: (session: string) => SessionSummary | undefined;
  /** The same private context the native push encrypts (push-content.ts); a web push is end-to-end encrypted too. */
  context?: (session: string, event: PushEvent) => PushContext | Promise<PushContext>;
  log?: (line: string) => void;
}

export class Notifier {
  private opts: NotifierOptions;
  private file: string;
  private subs: Record<string, Stored>;

  constructor(opts: NotifierOptions) {
    this.opts = opts;
    this.file = path.join(opts.dir, "push.json");
    this.subs = readJson<Record<string, Stored>>(this.file) ?? {};
  }

  devices(): string[] { return Object.keys(this.subs); }

  subscribe(clientId: string, sub: PushSubscriptionJSON, lang: "ko" | "en", now = Date.now()): void {
    if (!clientId || typeof sub?.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || typeof sub.keys?.p256dh !== "string" || typeof sub.keys?.auth !== "string") {
      throw new Error("invalid push subscription");
    }
    // One subscription per device; a device that re-subscribed replaces its old endpoint.
    this.subs[clientId] = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, lang: lang === "en" ? "en" : "ko", at: now };
    this.save();
  }

  unsubscribe(clientId: string): void {
    if (!(clientId in this.subs)) return;
    delete this.subs[clientId];
    this.save();
  }

  /** Called for every appended session event, and for each Mac-session alert (Sessions.onAlert). Resolves when every send finished (tests wait on it). */
  async onEvent(session: string, event: PushEvent): Promise<void> {
    if (event.kind !== "permission" && event.kind !== "result" && event.kind !== "question") return;
    if (!Object.keys(this.subs).length || this.opts.seenRecently(session)) return;
    const s = this.opts.summary(session);
    if (!s) return;
    // A question is an ask like an approval: it waits for the person, so it is urgent and short-lived.
    const urgent = event.kind === "permission" || event.kind === "question";
    // Resolve once per event, and only when there is a subscription to send it to.
    let context: Promise<PushContext> | undefined;
    await Promise.all(Object.entries(this.subs).map(async ([clientId, stored]) => {
      let p = pushFor(event, s, stored.lang);
      if (!p) return;
      // Say what the turn did, as the native push does; a phone that installed the web app keeps the
      // fixed words only when the context cannot be read.
      if (this.opts.context) {
        try {
          context ??= Promise.resolve(this.opts.context(session, event));
          const content = pushContent(event, stored.lang, await context, p.body);
          p = { ...p, title: content.title, body: content.body };
        } catch {
          this.opts.log?.(`push: content unavailable for device ${clientId.slice(0, 8)}; sending fixed words`);
        }
      }
      try {
        await this.opts.send(stored.sub, JSON.stringify(p), { urgency: urgent ? "high" : "normal", ttl: urgent ? 3600 : 86_400, topic: p.tag.replace(/[^\w-]/g, "").slice(0, 32) });
      } catch (e) {
        if (isGone(e)) {
          // Only drop it if it is still the subscription this send used, not one the phone just replaced.
          if (this.subs[clientId]?.sub.endpoint === stored.sub.endpoint) { delete this.subs[clientId]; this.save(); }
          this.opts.log?.(`push: subscription for device ${clientId.slice(0, 8)} is gone (${(e as { statusCode: number }).statusCode}); removed`);
        } else this.opts.log?.(`push: send failed for device ${clientId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }));
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.subs, null, 1));
  }
}
