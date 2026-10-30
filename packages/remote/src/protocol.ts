// Wire protocol between ripple-host and the phone client. Types and constants only, no
// imports: the host also serves this file to the browser (as /src/protocol.ts), so both ends
// read the same numbers.
//
// Every session has an append-only event log. An event's `seq` counts from 1 inside one
// `epoch`; a new epoch means the log was replaced (never happens in normal operation) and a
// client must drop what it holds for that session. A client that reconnects asks for
// everything after the last `seq` it has, so a re-attach is cheap and idempotent.

/** Largest WebSocket frame either side sends, in bytes of UTF-8 JSON (Paseo #2610: 8 MB killed the socket). */
export const FRAME_CAP = 256 * 1024;
/**
 * A host frame over FRAME_CAP is split for a client that advertised `chunkedFrames`: a `chunk`
 * frame carries one slice of the original frame's UTF-8 bytes, base64, and the shared Link joins
 * them and hands the whole JSON text to the normal handling. The original bytes are never cut,
 * escaped or rewritten, so a queue, edit answer or session list arrives exactly as it was built.
 * Chunks are only ever sent to a client that asked; every other client keeps the one-frame wire.
 *
 * The size cap is fixed so a broken or hostile sender cannot grow the phone's memory without
 * bound: past it the host takes today's `too_large` path instead of chunking.
 */
export const CHUNK_MESSAGE_MAX = 16 * 1024 * 1024;
/** Bytes a chunk frame spends on keys, its id, index and numbers, before the base64 payload. */
export const CHUNK_OVERHEAD = 1024;
/** Payload bytes per chunk: the largest base64 that still leaves FRAME_CAP room for the envelope. */
export const CHUNK_DATA_BYTES = Math.floor((FRAME_CAP - CHUNK_OVERHEAD) / 4) * 3;
/** A partial assembly with no chunk for this long is dropped; the link then reconnects. */
export const CHUNK_TIMEOUT_MS = 30_000;

/** A string field longer than this is moved out of the event into a blob fetched on demand. */
export const INLINE_CAP = 32 * 1024;
/** Client pings this often; either side calls the link stale after STALE_MS of silence. */
export const PING_MS = 10_000;
export const STALE_MS = 30_000;
/** Reconnect backoff is min(BACKOFF_CAP_MS, attempt × 1 s) and never stops. */
export const BACKOFF_CAP_MS = 30_000;
/** A socket that opens but is not ready (relay hello, host ready) within this is abandoned. */
export const READY_MS = 8_000;
/** Largest frame the relay forwards: an encrypted FRAME_CAP frame (16-byte tag) with room to spare. */
export const RELAY_FRAME_CAP = FRAME_CAP + 1024;

/**
 * The relay's own words (plain text frames; everything else it forwards untouched, encrypted):
 *   to the host's control socket: {"relay":"hello"} once accepted, {"relay":"connect","conn":id} per phone;
 *   to a phone: {"relay":"open"} once the host's data socket for it is there.
 * The host pings its control socket with the text "ping" and the relay answers "pong".
 */
export type RelayMsg = { relay: "hello" } | { relay: "connect"; conn: string } | { relay: "open" };
/** Close codes the relay uses. `stale`: the host's control socket sent no ping for HOST_SILENT_MS. */
export const RELAY_CLOSE = { badRequest: 4400, badSecret: 4401, hostOffline: 4404, stale: 4408, replaced: 4409, peerGone: 4410, tooBig: 1009 } as const;
/**
 * The relay routes phones only to the host's newest control socket, and only while that socket
 * pinged within this long (PING_MS cadence; a missed ping or two is not a verdict).
 */
export const HOST_SILENT_MS = STALE_MS + PING_MS;

export const PERMISSION_MODES = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export interface Question { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }
export interface PermissionContent { requestKind?: "tool" | "plan" | "question"; questions?: Question[]; alwaysAllow?: { scope: "session"; summary: string } }
export type RuleStatus = "sent" | "confirmed" | "unknown";
/** Only worker-confirmed values are included; a transport acknowledgement is not application. */
export interface SettingsResult {
  status: "applied" | "partial" | "unknown";
  model?: string;
  effort?: Effort | null;
  permissionMode?: PermissionMode;
  /** Requested model/effort waiting for a safe SDK restart; values above remain in force. */
  pending?: { model: string; effort: Effort | null };
  errors?: { model?: string; effort?: string; permissionMode?: string };
}
export interface SessionControls { model: boolean; effort: boolean; permissionModes: PermissionMode[] }

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type SessionState =
  | "starting" // query spawned, no answer yet
  | "running" // model or tool working
  | "waiting" // a permission request is open
  | "idle" // turn finished, ready for the next message
  | "stopped" // no live query (host restarted, or closed); the next message resumes it
  | "error"; // last turn ended in an error; the next message retries

/** How a new session branches the folder it starts in. */
export type Isolation = "local" | "worktree";

/**
 * Why a session wants the person's eye. The phone clears it when it opens that session, except
 * `permission`, which clears only when the approval itself is answered (a phone can look and leave).
 * `question` is a Claude app turn that stopped on its wrap_up's question and waits for the answer;
 * a client that does not know it must read it as an attention it can clear, never fail on it.
 */
export type AttentionReason = "permission" | "failed" | "finished" | "question";
export interface Attention { reason: AttentionReason; at: number }

/** A string moved out of an event (INLINE_CAP); the client fetches `/api/blob/<session>/<id>`. */
export interface BlobRef { blob: string; bytes: number; preview: string }
export type Text = string | BlobRef;

/** Image bytes are base64 in the existing chunked blob transport, never in an event. */
export interface ImagePart { type: "image"; blob?: string; mediaType: string; width?: number; height?: number }
export interface SessionFile { id: string; name: string; mediaType: string; bytes: number; status: "ready" | "blocked" | "missing" | "too_large"; blob?: string }
export interface MessageImages { images?: ImagePart[]; files?: SessionFile[] }
export const SESSION_FILE_TOTAL = 32 * 1024 * 1024;
export const SESSION_FILE_NAME = 160;
export const ATTACHMENT_CAP = 8 * 1024 * 1024;
export const ATTACHMENT_COUNT = 8;
export interface Attachment { blob: string; name: string; mediaType: string }
export type SendBehavior = "steer" | "interrupt";
export function defaultEffort(efforts: Effort[]): Effort | null { return efforts.includes("high") ? "high" : efforts[0] ?? null; }

export interface ToolCall { id: string; name: string; files?: SessionFile[]; /** one line a person reads: a command, a path */ summary: string; input?: Text; /** Computed before a large input becomes a blob. Counts describe supplied edits, not unseen file context. */ changes?: { added: number; removed: number } }

export type EventBody = MessageImages & (
  | { kind: "user"; text: string; clientMsgId: string }
  | { kind: "turn"; model: string; effort: Effort | null }
  /** Streamed text, coalesced by the host (~80 ms). Superseded by the `assistant` event with the same `msg`. */
  | { kind: "delta"; msg: string; text: string }
  /** One thinking block; deltas append, a final block replaces them (never expose signatures). */
  | { kind: "thinking"; msg: string; block: number; text: Text; delta?: boolean }
  /** A progress sentence the model wrote between tools: shown, unlike thinking. Its signature never travels. */
  | { kind: "narration"; msg: string; block: number; text: Text }
  | { kind: "assistant"; msg: string; model: string; text: Text; tools: ToolCall[] }
  | { kind: "tool_result"; toolUseId: string; ok: boolean; text: Text }
  /** A subagent ran; its own log is `sub` and loads only when asked (Paseo #5820). */
  | { kind: "subagent"; toolUseId: string; sub: string; description: string; model: string | null; status: "running" | "done" | "failed" | "stopped"; steps: number }
  | ({ kind: "permission"; id: string; tool: string; title: string; summary: string; input: Text; canAlways: boolean } & PermissionContent)
  | { kind: "background"; tasks: BackgroundTask[]; known: boolean }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "permission_decided"; id: string; decision: "allow" | "allow_always" | "deny" | "expired"; reason?: string; ruleStatus?: RuleStatus }
  | ({ kind: "settings"; reqId: string } & SettingsResult)
  | { kind: "result"; ok: boolean; error?: string; ms: number; turns: number }
  | { kind: "state"; state: SessionState; detail?: string }
  | { kind: "figures"; figures: Figures }
  | { kind: "notice"; code: NoticeCode; text?: string });

export type NoticeCode = "host_restarted" | "interrupted" | "api_retry" | "router_down" | "model_changed" | "resumed" | "desktop_open" | "desktop_resumed" | "desktop_bridge" | "desktop_blocked" | "desktop_handoff" | "desktop_handoff_requested" | "desktop_handoff_retry" | "desktop_handoff_failed" | "desktop_settings_failed";

export type SessionEvent = EventBody & { seq: number; at: number };

/**
 * A push-worthy moment on a Mac session the host is not tailing: a turn finished (ok/failed), a turn
 * closed on a question the person must answer, or an approval is waiting. It goes to the pushes only,
 * never into a session log, so it carries just what they read — a bridged session's own
 * result/permission events carry the rest.
 */
export type AlertBody = { kind: "permission" } | { kind: "result"; ok: boolean }
  /** A Claude app turn that closed on its wrap_up: `ask` is the question, and `blocked` says the
   * session does not go on until the person answers it. */
  | { kind: "question"; ask: string; blocked: boolean };
/** What a push reads: a real log event, or an alert for a Mac session the host does not tail. */
export type PushEvent = EventBody | AlertBody;

/** The mod's figures, as the phone shows them under the header. Null means "not known", never zero. */
export interface Figures {
  effort: Effort | null;
  /** cache read / all input of this session's main-model requests, 0–100 */
  cachePct: number | null;
  /** last request's input / the model's window, 0–100 */
  contextPct: number | null;
  /** Claude subscription 5-hour window used, 0–100 */
  fiveHourPct: number | null;
  fiveHourResetAt: number | null;
  /** model → requests, for every model other than the session's own that served this session */
  workers: { model: string; provider: string; requests: number }[];
  /** last request's input tokens and the window they are read against; absent on older hosts */
  contextTokens?: number | null;
  contextWindow?: number | null;
  /** where the session's latest main-model request went; null when the router has none; absent on older hosts */
  route?: { model: string; provider: string; ok: boolean; status: number | null } | null;
  at: number;
}

/** One provider window from the router's /api/limits, as the desktop band's limits row shows it. */
export interface RippleLimit {
  /** router provider name, e.g. "anthropic", "chatgpt"; `title` is what the band heads it with */
  provider: string;
  title: string;
  /** account label when a provider pools several; absent for one */
  account?: string;
  kind: "five_hour" | "seven_day" | "scoped" | "window";
  /** the router's own label for scoped/other windows; null for five_hour/seven_day */
  label: string | null;
  usedPct: number;
  windowMinutes: number | null;
  /** epoch ms; null when the router gave none */
  resetAt: number | null;
}

/** What the ClaudeRipple mod is set to on this Mac, host-wide (it is not per session). */
export interface RippleStatus {
  /** the active operating mode from mod settings; null when none is active */
  mode: { id: string; name: string; since: number | null } | null;
  /** automatic effort on, and the range it is held in */
  effortAuto: boolean;
  effortFloor: Effort | null;
  effortCeiling: Effort | null;
  /** every provider window with a reset still ahead, Claude first */
  limits: RippleLimit[];
  at: number;
}

export interface SessionSummary {
  id: string;
  origin?: "host" | "desktop";
  readOnly?: boolean;
  title: string;
  /** Desktop sidebar metadata; absent on older hosts. */
  unread?: boolean;
  group?: string;
  order?: number;
  cwd: string;
  model: string;
  effort: Effort | null;
  /** Absent means unknown, including a desktop handoff whose mode the host cannot confirm. */
  permissionMode?: PermissionMode;
  /** Requested model/effort not yet in force while background work prevents restart. */
  pendingSettings?: SettingsResult["pending"];
  /** Absent on older hosts: controls must stay disabled. Values above describe the next turn. */
  controls?: SessionControls;
  state: SessionState;
  /** Main-turn state is authoritative for desktop Remote Control sessions. */
  desktopBridge?: boolean;
  /** Running background workers/shells, separate from the main turn. */
  tasks?: number;
  /** Desktop sessions: when the running main turn began, from the person's message in the transcript.
   * The phone's event window may not reach back that far. Null when unknown; absent on older hosts. */
  turnStartedAt?: number | null;
  /** What those background tasks are, oldest first; absent on older hosts. */
  taskList?: BackgroundTask[];
  taskHistory?: BackgroundTask[];
  /** False/absent means transcript observations only, not a complete inventory of PR/CI subscriptions. */
  backgroundKnown?: boolean;
  activityAt?: number | null;
  /** Confirmed tasks from update_plan, TodoWrite and TaskCreate/Update/List, in order.
   * Session-scoped tasks survive turn completion; Code's per-turn plan clears on a new human turn. */
  plan?: PlanStep[];
  /** The main turn is idle but background work (subagents, shells) still runs: the app's dark blink. */
  background?: boolean;
  /** open permission requests */
  pending: number;
  /** Messages the phone queued, oldest first; the host sends each when the turn before it ends.
   * Absent when empty and on older hosts (HostInfo.queue says the host keeps them). */
  queue?: QueuedMessage[];
  /** The phone's Stop paused the queue (or its head failed): nothing goes until a send or resume. */
  queueHeld?: boolean;
  /** The host's archive flag: an archived session leaves the default list but is never deleted
   * (transcripts and files stay). Absent on older hosts. */
  archived?: boolean;
  /** The Claude app's own sidebar line for this session: the first sentence of the last wrap_up's
   * recap (≤200 characters). Cleared when the person sends a new message, since the next turn is
   * already under way. Claude app sessions only; absent on older hosts and for host sessions. */
  status?: string;
  /** The session wants the person's eye; the phone's `seen` clears all but a permission request.
   * Absent on older hosts; null means nothing is waiting. */
  attention?: Attention | null;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  epoch: string;
}

export interface BackgroundTask {
  id: string; kind: "agent" | "shell" | "monitor" | "schedule" | "subscription" | "other"; label: string; startedAt: number | null;
  sub?: string; state?: "running" | "done" | "failed" | "stopped" | "unknown";
  command?: string; schedule?: string; nextAt?: number; endedAt?: number; category?: string;
}
export interface PlanStep { id?: string; text: string; status: "pending" | "in_progress" | "completed" }

/** One queued message as the phone shows it; `id` is the phone's clientMsgId. */
export interface QueuedMessage { id: string; text: string; attachments: number; at: number; /** Why it failed or is waiting; only queueHeld requires explicit resume. */ error?: string }

export interface ModelOption { model: string; name: string; provider: string; efforts: Effort[]; usable: boolean }
export interface ProviderGroup { provider: string; label: string; usable: boolean; models: ModelOption[] }

export interface FolderEntry { path: string; name: string; lastUsed?: number; model?: string }
/** One row in a session folder's read-only listing; `path` is relative to the session folder. */
export interface SessionFolderEntry { name: string; path: string; dir: boolean; bytes: number | null; /** a symlink that leads outside the folder: shown, not opened */ blocked?: boolean }
export interface FolderListing { path: string; parent: string | null; entries: SessionFolderEntry[]; truncated: boolean }
/** One small file from a session folder, base64. Larger files are refused, never truncated. */
export interface FolderFile { path: string; name: string; mediaType: string; bytes: number; data: string }

/**
 * `desktopProblem`: why sends, approvals and live state for Claude app (Mac) sessions cannot work
 * right now — this Mac's Claude login, in the host's words — absent when they can.
 */
export interface HostInfo { name: string; version: string; routerOk: boolean; routerProblem?: string; desktopProblem?: string;
  /** The host keeps queued messages (ReqOp enqueue/queue_*); an older host leaves the queue to the phone. */
  queue?: boolean;
  capabilities?: { sessionFiles: boolean;
    /** read-only session folder listing and small-file reads */ folderFiles?: boolean;
    /** `op: "diff"` takes a `scope`, so the diff pane can switch between uncommitted work and the
     * branch. Absent on an older host, which always answers with its own order. */
    diffScope?: boolean };
  /** the mod's mode, effort range and provider limits; absent on older hosts or when the router is down */
  ripple?: RippleStatus }

// ---- client → host --------------------------------------------------------------------

/** Per-connection opt-in. Missing/non-array lists mean no features; unknown entries are ignored. */
export const CLIENT_FEATURES = ["settingsResult", "scopedAlways", "sessionFiles", "chunkedFrames", "folderFiles"] as const;
export type ClientFeature = typeof CLIENT_FEATURES[number];

export type ClientMsg =
  | { t: "hello"; token: string; clientId: string; features?: ClientFeature[] }
  | { t: "ping"; n: number }
  /** `afterSeq` 0 or absent with no epoch: send the tail page. */
  | { t: "attach"; session: string; epoch?: string; afterSeq?: number }
  | { t: "detach"; session: string }
  /** The cursor belongs to epoch; omitted by older clients. */
  | { t: "history"; session: string; beforeSeq: number; reqId: string; epoch?: string }
  | { t: "create"; clientMsgId: string; cwd: string; model: string; effort: Effort | null; text: string; permissionMode?: PermissionMode; isolation?: Isolation; baseBranch?: string }
  /** The phone is looking at this session now; clears its attention (a permission request stays). */
  | { t: "seen"; session: string }
  /** Archive/unarchive: a flag only, the session's transcripts and files stay. */
  | { t: "archive"; session: string; archived: boolean }
  /** "Mark unread": put the attention back, guessed from what the session is doing now. */
  | { t: "unread"; session: string }
  | { t: "set_mode"; reqId: string; sessionId: string; mode: PermissionMode }
  | { t: "send"; session: string; clientMsgId: string; text: string; behavior?: SendBehavior; attachments?: Attachment[] }
  | { t: "decide"; session: string; id: string; decision: "allow" | "allow_always" | "deny"; reqId?: string; message?: string; answers?: Record<string, string> }
  | { t: "interrupt"; session: string; reqId?: string }
  | { t: "set_model"; session: string; model: string; effort: Effort | null; reqId?: string }
  /** The app is in front (visible) or not. Sent on change and every PING_MS while visible; the host pushes only when nobody is looking. */
  | { t: "presence"; visible: boolean }
  /** Request/response over the same socket, so a relay later forwards one stream and nothing else. */
  | { t: "req"; reqId: string; op: ReqOp };

export type ReqOp =
  | { op: "models" }
  | { op: "upload"; session: string; uploadId: string; offset: number; data: string; done: boolean }
  | { op: "folders" }
  | { op: "browse"; path?: string; hidden?: boolean }
  /** Make a folder directly inside `parent`; `name` is one path segment, validated on the host. */
  | { op: "mkdir"; parent: string; name: string }
  /** What a folder's git situation is, for the new-session isolation choice. */
  | { op: "git"; path: string }
  | { op: "blob"; session: string; id: string; offset?: number }
  | { op: "sub"; session: string; sub: string; afterSeq?: number }
  /** What changed in this session's own folder; the host reads the folder from the session, never
   * from the phone. Read-only: a scope, a base branch, and one patch per file (see DiffView).
   * `scope` picks the comparison (`auto` is the host's own order); hosts that do not know it answer
   * as `auto`, and the answer's own `scope` is what was actually shown. */
  | { op: "diff"; session: string; scope?: DiffScope }
  /** Slash command names (no "/") the session accepts, for the composer's "/" menu. */
  | { op: "commands"; session: string }
  /** Read-only listing of a session folder; `path` is relative to it. */
  | { op: "folder_list"; session: string; path?: string }
  /** One small file from that listing, base64; refuses anything larger. */
  | { op: "folder_file"; session: string; path: string }
  /** Queue a message for when the running turn ends; attachments are uploads, as for `send`. A
   * session that is not busy takes it at once. Answers `{ queued: true }`; a resent id is a no-op. */
  | { op: "enqueue"; session: string; clientMsgId: string; text: string; attachments?: Attachment[] }
  /** Take a queued message out: returns { text, attachments: Attachment[] } for editing. */
  | { op: "queue_remove"; session: string; id: string }
  /** Send a queued message now, into the running turn like a steer; un-holds the queue. */
  | { op: "queue_send"; session: string; id: string }
  /** Let a held queue go on by itself again. */
  | { op: "queue_resume"; session: string }
  /** The host's VAPID public key (base64url), for PushManager.subscribe's applicationServerKey. */
  | { op: "push_key" }
  | { op: "push_subscribe"; subscription: PushSubscriptionJSON; lang: "ko" | "en" }
  | { op: "push_unsubscribe" }
  /** Optional native push key travels inside the authenticated E2EE channel, never via Expo. */
  | { op: "expo_push_subscribe"; token: string; lang: "ko" | "en"; platform?: "ios" | "android"; key?: string }
  | { op: "expo_push_unsubscribe" };

/** PushSubscription.toJSON() as the browser gives it. */
export interface PushSubscriptionJSON { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }

export interface BrowseResult { path: string; parent: string | null; home: string; entries: FolderEntry[]; truncated: boolean }
/** A folder's git situation: whether it is inside a repo, that repo's root, its branch and local branches. */
export interface GitInfo { isRepo: boolean; root: string | null; branch: string | null; branches: string[] }
export interface BlobChunk { text: string; offset: number; next: number | null; bytes: number }
export interface SubPage { events: SessionEvent[]; more: boolean }

/**
 * The session folder's changes, for the phone's diff pane (the official app's diff view). The answer
 * to `op: "diff"`: which question the folder is asking (uncommitted work, or a branch ahead of its
 * base), what the base branch is, and one unified patch per changed file. A phone shows it as a
 * file list with each file's patch beneath; nothing here is fetched, checked out or written.
 */
export interface DiffView {
  /** `uncommitted`: the folder has work that is not committed — staged and unstaged changes against
   * HEAD plus untracked files, shown first so a mid-session thought is never hidden by a branch.
   * `branch`: the folder is clean and its current branch is ahead of the base branch, so the view
   * is merge-base..HEAD. `clean`: neither — the folder holds no change this session made. */
  scope: "uncommitted" | "branch" | "clean";
  /** The branch a `branch` view is measured against (`origin/main`, else `main`, else `master`);
   * null in every other scope. */
  base: string | null;
  /** The folder's current branch; null when it is not on one (detached HEAD). */
  branch: string | null;
  /** Changed files in git's order, untracked ones last; cut to the size limits below. */
  files: DiffFile[];
  /** Something was left out: more than 300 files, a patch past 200 KB, 2 MB of patches in all, or
   * more than one frame can carry. Counts in `files` are still complete. */
  truncated: boolean;
}

/** One changed file. `added`/`removed` come from git's numstat, before any truncation, so a cut
 * patch still says how big the change was. */
export interface DiffFile {
  /** path from the repository root, as git prints it */
  path: string;
  /** where the file was, for a rename */
  oldPath?: string;
  /** how it changed; `binary` is a file whose content cannot be a patch (a new binary is `binary`
   * rather than `untracked`, since there is nothing to show) */
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "binary";
  /** lines added */
  added: number;
  /** lines removed */
  removed: number;
  /** the unified diff text; empty for binary files and for a file the limits cut away */
  patch: string;
  /** This file's patch is not all of it: a size limit, a deadline or the frame budget stopped it.
   * Absent when the patch (or its absence, for a binary) is complete. */
  cut?: boolean;
}

/** Which comparison a diff view makes. `auto` is the host's own order: uncommitted work first,
 * else the branch against its base. The other two ask for one of them, even when it is empty. */
export type DiffScope = "auto" | "uncommitted" | "branch";

// ---- host → client --------------------------------------------------------------------

/**
 * One slice of a host frame too large for FRAME_CAP, sent only to a client whose hello listed
 * `chunkedFrames`. `data` is base64 of the original frame's UTF-8 bytes at `index` of `total`;
 * `bytes` is the whole original length, the same on every slice. The shared Link assembles these
 * before any other handling (chunks.ts), so the app never sees this type.
 */
export interface ChunkFrame { t: "chunk"; id: string; index: number; total: number; bytes: number; data: string }

export type HostMsg =
  | ChunkFrame
  | { t: "ready"; host: HostInfo; sessions: SessionSummary[]; groups?: string[] | undefined }
  | { t: "pong"; n: number }
  | { t: "denied"; reason: "token" }
  /** Events after the client's seq. `more` means another frame follows at once. `tail` means older events exist before `events[0]`. */
  | { t: "events"; session: string; epoch: string; events: SessionEvent[]; more: boolean; tail?: { hasOlder: boolean } }
  /** Epoch actually read; absent on older hosts. A mismatched request gets no page and a fresh tail. */
  | { t: "history"; session: string; reqId: string; epoch?: string; events: SessionEvent[]; hasOlder: boolean }
  | { t: "sessions"; sessions: SessionSummary[]; groups?: string[] | undefined }
  | { t: "host"; host: HostInfo }
  | { t: "ack"; clientMsgId: string; session: string }
  | { t: "res"; reqId: string; ok: true; data: unknown }
  | { t: "res"; reqId: string; ok: false; error: string }
  | { t: "error"; code: string; message: string; clientMsgId?: string; session?: string };
