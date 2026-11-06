// Only generic fallback copy and encrypted content cross the native push provider boundary.
import { createCipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { pushContent, type PushContent, type PushContext } from "./push-content.ts";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { EXPO_PUSH_URL, EXPO_TOKEN_RE } from "./protocol.ts";
import type { PushEvent } from "./protocol.ts";

export interface ExpoPayload {
  to: string;
  title?: "Ripple Remote";
  body?: string;
  data: { session: string; e?: string; fallback?: string };
  sound?: "default";
  mutableContent?: true;
  priority?: "high";
  ttl: number;
}
export type ExpoSender = (payload: ExpoPayload) => Promise<"sent" | "gone">;
interface Stored { token: string; lang: "ko" | "en"; platform?: "ios" | "android"; key?: string }
interface NotifierOptions {
  dir: string; send: ExpoSender; seenRecently: (session: string) => boolean; log: (line: string) => void;
  context?: (session: string, event: PushEvent) => PushContext | Promise<PushContext>;
  /** The identity the phone pairs with (the relay pairing's host key). It rides in the payload so a
   * tap from a previous computer is not opened against this one. */
  host?: string;
}

export function validPushKey(key: string): boolean {
  return typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, "base64url").toString("base64url") === key;
}

/** RFC 8439 / CryptoKit combined format: nonce(12) ‖ ciphertext ‖ tag(16), no AAD. */
export function encryptPush(key: string, content: PushContent): string {
  if (!validPushKey(key)) throw new Error("invalid push key");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", Buffer.from(key, "base64url"), nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(content), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

export const validExpoToken = (token: string): boolean => EXPO_TOKEN_RE.test(token);

export function expoBody(event: PushEvent, lang: "ko" | "en"): string | null {
  if (event.kind === "permission") return lang === "ko" ? "승인을 기다립니다" : "Waiting for approval";
  // Fixed words only: this body travels in the clear beside the encrypted content (iOS `body`, the
  // Android fallback), and the question itself is the model's text — it goes only inside `e`.
  if (event.kind === "question") return lang === "ko" ? "답변이 필요합니다" : "Answer needed";
  if (event.kind !== "result") return null;
  if (event.ok) return lang === "ko" ? "작업을 마쳤습니다" : "Work finished";
  return lang === "ko" ? "작업이 실패했습니다" : "Work failed";
}

/** Inject only external boundaries: HTTP and the wait for Expo's asynchronous receipts. */
export function expoSender(fetcher: typeof fetch = fetch, wait: () => Promise<void> = () => new Promise(resolve => { setTimeout(resolve, 15_000).unref(); })): ExpoSender {
  return async (payload) => {
    const response = await fetcher(EXPO_PUSH_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Expo push HTTP ${response.status}`);
    const json = await response.json() as { data?: { status?: string; id?: string; message?: string; details?: { error?: string } } };
    const ticket = json.data;
    if (ticket?.details?.error === "DeviceNotRegistered") return "gone";
    if (ticket?.status !== "ok" || !ticket.id) throw new Error(ticket?.message ?? "invalid Expo push ticket");
    // Receipt errors can arrive after an accepted ticket. Poll for up to 15 minutes without
    // blocking the session's append (main calls onEvent asynchronously).
    for (let attempt = 0; attempt < 60; attempt++) {
      await wait();
      const receiptResponse = await fetcher("https://exp.host/--/api/v2/push/getReceipts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [ticket.id] }), signal: AbortSignal.timeout(15_000),
      });
      if (!receiptResponse.ok) throw new Error(`Expo receipts HTTP ${receiptResponse.status}`);
      const receiptJson = await receiptResponse.json() as { data?: Record<string, { status?: string; message?: string; details?: { error?: string } }> };
      const receipt = receiptJson.data?.[ticket.id];
      if (!receipt) continue;
      if (receipt.details?.error === "DeviceNotRegistered") return "gone";
      if (receipt.status !== "ok") throw new Error(receipt.message ?? "Expo receipt failed");
      return "sent";
    }
    throw new Error("Expo receipt timed out");
  };
}

export class ExpoNotifier {
  private file: string;
  private tokens: Record<string, Stored>;
  private opts: NotifierOptions;
  constructor(opts: NotifierOptions) {
    this.opts = opts;
    this.file = path.join(opts.dir, "expo-push.json");
    this.tokens = readJson<Record<string, Stored>>(this.file) ?? {};
  }
  devices(): string[] { return Object.keys(this.tokens); }
  /**
   * Every device and its language, for the relay's dead-man switch (src/watch.ts sends these to the
   * host's own room). Tokens are the relay's only stored data about this host — see ARCHITECTURE §9.
   */
  targets(): { token: string; lang: "ko" | "en" }[] {
    return Object.values(this.tokens).map((stored) => ({ token: stored.token, lang: stored.lang }));
  }
  /**
   * One host-wide notice to every native device, independent of which session a phone is looking
   * at (SEEN_MS does not apply: the news is not about a conversation). The copy is fixed and public,
   * so it travels in the clear beside the usual identity and no session id.
   */
  async system(body: (lang: "ko" | "en") => string, ttl: number): Promise<void> {
    await Promise.all(Object.entries(this.tokens).map(async ([id, stored]) => {
      try {
        const identity = this.opts.host ? { host: this.opts.host } : {};
        const result = await this.opts.send({ to: stored.token, title: "Ripple Remote", body: body(stored.lang), data: { session: "", ...identity }, sound: "default", ttl });
        if (result === "gone" && this.tokens[id] === stored) this.unsubscribe(id);
      } catch (error) {
        this.opts.log(`expo push: send failed for device ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  subscribe(clientId: string, token: string, lang: "ko" | "en", platform?: "ios" | "android", key?: string): void {
    if (!clientId || typeof token !== "string" || !validExpoToken(token)) throw new Error("invalid Expo push token");
    if (key !== undefined && (!validPushKey(key) || (platform !== "ios" && platform !== "android"))) throw new Error("invalid push key or platform");
    this.tokens[clientId] = { token, lang: lang === "en" ? "en" : "ko", ...(key && platform ? { key, platform } : {}) };
    this.save();
  }
  unsubscribe(clientId: string): void {
    if (!(clientId in this.tokens)) return;
    delete this.tokens[clientId];
    this.save();
  }
  async onEvent(session: string, event: PushEvent): Promise<void> {
    if (this.opts.seenRecently(session)) return;
    // Resolve once per event, lazily: old devices must never cause private context reads.
    let context: Promise<PushContext> | undefined;
    await Promise.all(Object.entries(this.tokens).map(async ([id, stored]) => {
      const body = expoBody(event, stored.lang);
      if (!body) return;
      try {
        const identity = this.opts.host ? { host: this.opts.host } : {};
        let payload: ExpoPayload = { to: stored.token, title: "Ripple Remote", body, data: { session, ...identity }, sound: "default", ttl: event.kind === "permission" || event.kind === "question" ? 3600 : 86400 };
        if (stored.key) {
          try {
            context ??= Promise.resolve(this.opts.context?.(session, event) ?? {});
            const e = encryptPush(stored.key, pushContent(event, stored.lang, await context, body));
            payload = stored.platform === "android"
              ? { to: stored.token, data: { session, ...identity, e, fallback: body }, priority: "high", ttl: payload.ttl }
              : { ...payload, mutableContent: true, data: { session, ...identity, e } };
          } catch {
            // No private exception text in logs; a context/crypto failure must still deliver fallback.
            this.opts.log(`expo push: content unavailable for device ${id.slice(0, 8)}; sending fallback`);
          }
        }
        // An unsubscribe/replacement during context lookup must not send an obsolete key/token.
        if (this.tokens[id] !== stored) return;
        const result = await this.opts.send(payload);
        if (result === "gone" && this.tokens[id] === stored) this.unsubscribe(id);
      } catch (error) {
        this.opts.log(`expo push: send failed for device ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  private save(): void { writeFileAtomic(this.file, JSON.stringify(this.tokens, null, 1)); }
}
