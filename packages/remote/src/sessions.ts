// Sessions are the host's. Each one is a Claude Code process driven through the Agent SDK in
// a folder and on a model the phone chose, sent through the router like any CLI (ARCHITECTURE
// §1: HTTPS_PROXY + NODE_EXTRA_CA_CERTS — not ANTHROPIC_BASE_URL, which the router's proxy port
// answers 405; measured 2026-10-11, docs/specs/2026-10-11-ripple-remote-ux.md). Everything a
// phone may need later goes into the session's event log before it goes to any socket.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventLog } from "./eventlog.ts";
import { narrationBody } from "./narration.ts";
import { TaskPlan } from "./task-plan.ts";
import { BackgroundActivity } from "./background-activity.ts";
import { toolInput } from "./tool-details.ts";
import type { PushContext } from "./push-content.ts";
import type { PushEvent } from "./protocol.ts";
import { attachmentContent, fileImages, messageContent, sessionFileTool, type InputBlock } from "./images.ts";
import { ATTACHMENT_CAP, ATTACHMENT_COUNT, type Attachment, type ImagePart, type SessionFile, type SendBehavior } from "./protocol.ts";
import { DesktopSessions, type DesktopProcess, type TurnWrapUp } from "./desktop.ts";
import { firstSentence, STATUS_CAP } from "./wrap-up.ts";
import { DesktopSidebar, PHONE_GROUP, type SidebarOptions } from "./sidebar.ts";
import { BridgeAuthError, BridgeClient, bridgeCreateNotCreated, bridgeWriteUnknown, CLI_NOT_LOGGED_IN, DESKTOP_BLOCKED, DESKTOP_BUSY, DESKTOP_WAITING, DesktopBlockedError, DesktopBusyError, isCliNotLoggedIn, object, permissionSuppression, slashCommands, type BridgeFrame } from "./bridge-client.ts";
import type { HandoffRunner } from "./handoff.ts";
import { isDirectory, macConsent, readableFolder } from "./folders.ts";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { createWorktree } from "./worktree.ts";
import { MessageReceipts, OutcomeUnknownError } from "./receipts.ts";
import { SessionSettings, sessionPermissionRules } from "./session-controls.ts";
import type { BridgePermissionRequest } from "./bridge-client.ts";
import type { SessionControls, SettingsResult } from "./protocol.ts";

interface BridgePending {
  id: string; input: Record<string, unknown>; toolUseId: string;
  rules: ReturnType<typeof sessionPermissionRules>;
}
import { SendQueue, type QueueItem } from "./queue.ts";
import { ModInbox, type ModOffer, type ModOutcome } from "./mod-inbox.ts";
import { SettingsJobs, settingsEffort, settingsModel, type SettingsJob, type SettingsJobOutcome } from "./settings-jobs.ts";
import { DesktopSettings, type AppSettings } from "./desktop-settings.ts";
import type { Decision, PermissionQueue } from "./permissions.ts";
import { PERMISSION_MODES, type AlertBody, type Attention, type AttentionReason, type PermissionMode, type Question, type Effort, type EventBody, type Figures, type Isolation, type SessionEvent, type SessionState, type SessionSummary, type ToolCall } from "./protocol.ts";
import type { RouterClient } from "./router.ts";

// ---- the slice of the Agent SDK this file relies on (typed loosely so tests can fake it) ----

export interface SdkUserMessage { type: "user"; message: { role: "user"; content: string | InputBlock[] }; parent_tool_use_id: null; session_id: string; uuid?: string; origin?: { kind: "human" } }
export interface SdkQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  close(): void;
  /** The launcher resolves this only after the transcript writer has exited. */
  processExited?: Promise<void>;
}
export type PermissionAnswer =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };
export type CanUseTool = (tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; suggestions?: unknown[]; suppressAlwaysAllowRule?: boolean; title?: string; decisionReason?: string; toolUseID?: string }) => Promise<PermissionAnswer>;
export type QueryFn = (params: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => SdkQuery;

interface AppSettingsGuard {
  jobId: string;
  model: string;
  effort: Effort | null;
  baselineEffort: string | undefined;
  outcome: "pending" | "applied" | "failed";
  modelObserved?: boolean;
  effortObserved?: boolean;
}

interface SessionRecord {
  id: string;
  sdkSessionId: string | null;
  cwd: string;
  model: string;
  effort: Effort | null;
  permissionMode?: PermissionMode;
  prePlanMode?: PermissionMode;
  /** The initial launch allowance is immutable; mode changes must not add a bypass flag. */
  bypassAllowed?: boolean;
  /** Confirmed next-turn settings outrank historical assistant/user transcript metadata. */
  confirmedSettings?: Omit<SettingsResult, "status" | "errors" | "pending">;
  title: string;
  createdAt: number;
  updatedAt: number;
  state: SessionState;
  createdBy: string;
  contextWindow: number | null;
  /** Missing on older host records; desktop continuations are explicitly excluded. */
  desktopHandoff?: "pending" | "opening" | "attempted" | "failed" | "excluded";
  desktopHandoffRetryAt?: number;
  desktopHandoffAttempts?: number;
  desktopHandoffError?: string;
  desktopBridge?: boolean;
  /** Environment-created sessions have a bridge identity before Desktop assigns a CLI id. */
  environmentBridgeId?: string;
  environmentCreateUnknown?: boolean;
  appSettingsBirthRequested?: boolean;
  appSettingsGuard?: AppSettingsGuard;
  transcriptOffset?: number;
}

interface Live {
  query: SdkQuery;
  ready: Promise<void>;
  input: Inbox;
  abort: AbortController;
  /** Text deltas waiting to be written (coalesced, ~80 ms). */
  buffer: { msg: string; text: string; thinking?: { block: number; text: string } } | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Content blocks of the API message being streamed, merged across the SDK's per-block messages. */
  current: { msg: string; text: string; images?: ImagePart[]; files?: SessionFile[]; tools: ToolCall[]; model: string; thinkingBlocks: number[]; nextThinkingBlock: number } | null;
  /** Task/Agent tool ids → their subagent while it runs */
  subs: Map<string, { description: string; model: string | null; steps: number; parent?: string }>;
  turnStart: number;
  restartAfterTurn: boolean;
  retried: boolean;
  interrupted: boolean;
  /** Inputs still owed a result, including ones the SDK already read into its own queue. */
  pendingMessages: SdkUserMessage[];
}

export interface SessionsOptions {
  dir: string;
  router: Pick<RouterClient, "status" | "figures">;
  permissions: PermissionQueue;
  queryFn: QueryFn;
  claudePath?: string;
  handoff?: HandoffRunner;
  log?: (line: string) => void;
  onEvent: (session: string, event: SessionEvent) => void;
  onSessions: () => void;
  /** A turn finished/failed, or an approval is waiting, on a Mac session the host is not tailing.
   * Fired only while `away`, and never appended to a log (main sends it to the pushes). */
  onAlert?: (session: string, body: AlertBody) => void;
  /** Whether the Mac is away (screen locked, or no input for a while). Missing: never alert. */
  away?: () => Promise<boolean>;
  /** Claude app sessions became unreachable for the whole host (the Mac's Claude login), or reachable again (null). */
  onDesktopProblem?: (problem: string | null) => void;
  now?: () => number;
  coalesceMs?: number;
  /** Enabled by main; tests can use an isolated synthetic projects directory. */
  desktopProjects?: string;
  desktopSidebar?: SidebarOptions;
  desktopProcesses?: () => string;
  desktopRegistry?: () => Map<string, DesktopProcess>;
  bridgeClient?: BridgeClient;
  /** Test boundary for the app's data directory and bounded attachment wait. */
  environmentRoot?: string;
  environmentWaitMs?: number;
  environmentPollMs?: number;
  environmentModeMs?: number;
  modOfferMs?: number;
  modResultMs?: number;
  settingsJobExpiryMs?: number;
  /** Optional file-notification boundary; polling remains authoritative when unavailable. */
  watchTranscript?: (id: string, changed: () => void, failed: (error: unknown) => void) => (() => void) | null;
}

/** An async iterable the SDK reads user messages from; a session's query lives as long as it. */
class Inbox implements AsyncIterable<SdkUserMessage> {
  private queue: SdkUserMessage[] = [];
  private waiting: ((r: IteratorResult<SdkUserMessage>) => void) | null = null;
  private done = false;
  push(m: SdkUserMessage): void {
    if (this.done) return;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: m, done: false }); } else this.queue.push(m);
  }
  close(): void {
    this.queue = [];
    this.done = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined, done: true }); }
  }
  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

/** Routed models take their effort as `model@level`, which the router reads (ARCHITECTURE §3a); Claude models take the SDK's own option. */
function isClaudeModel(model: string): boolean { return model.startsWith("claude-") || /^(opus|sonnet|haiku)(\[1m\])?$/.test(model); }

export function modelArg(model: string, effort: Effort | null): { model: string; effort?: Effort } {
  // Claude Code's own aliases (router.ts offers them when no anthropic provider is declared) are
  // Claude models too: `opus@high` would reach Anthropic as a model nobody has.
  if (isClaudeModel(model)) return effort && ["low", "medium", "high", "xhigh", "max"].includes(effort) ? { model, effort } : { model };
  return { model: effort ? `${model}@${effort}` : model };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, n = 200): string => { const l = s.split("\n").find((x) => x.trim()) ?? ""; return l.length > n ? l.slice(0, n - 1) + "…" : l; };

function relativeToCwd(file: string, cwd: string): string {
  if (!file || !path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  if (!relative) return ".";
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : file;
}

/** One line a person reads to know what a tool call does. */
export function summarize(tool: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (file: string): string => relativeToCwd(file, cwd);
  switch (tool) {
    case "Bash": return oneLine(str(input.command));
    case "Read": case "Write": case "Edit": case "MultiEdit": return rel(str(input.file_path));
    case "NotebookEdit": return rel(str(input.notebook_path));
    case "Glob": return str(input.pattern);
    case "Grep": return `${str(input.pattern)}${input.path ? "  " + rel(str(input.path)) : ""}`;
    case "WebFetch": return str(input.url);
    case "WebSearch": return str(input.query);
    case "Task": case "Agent": return oneLine(str(input.description));
    case "SendUserFile": {
      const files = (Array.isArray(input.files) ? input.files : []).filter((f): f is string => typeof f === "string").map(rel);
      return oneLine([...files, str(input.caption)].filter(Boolean).join(", "));
    }
    case "AskUserQuestion": return oneLine(str(object(Array.isArray(input.questions) ? input.questions[0] : null)?.question));
    case "ExitPlanMode": return oneLine(str(input.plan));
    case "EnterPlanMode": return "";
    case "TodoWrite": return Array.isArray(input.todos) ? `${input.todos.length}` : "";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ? oneLine(first) : oneLine(JSON.stringify(input), 120);
    }
  }
}

/** What the permission card shows in full: the command, the change, or the arguments. */
export function permissionDetail(tool: string, input: Record<string, unknown>, cwd: string): string {
  if (tool === "Bash") return str(input.command);
  if (tool === "Edit") return `${summarize(tool, input, cwd)}\n- ${str(input.old_string).split("\n").join("\n- ")}\n+ ${str(input.new_string).split("\n").join("\n+ ")}`;
  if (tool === "Write") return `${summarize(tool, input, cwd)}\n+ ${str(input.content).split("\n").join("\n+ ")}`;
  if (tool === "MultiEdit" && Array.isArray(input.edits)) return input.edits.map(edit => permissionDetail("Edit", { ...object(edit), file_path: input.file_path }, cwd)).join("\n\n");
  if (tool === "ExitPlanMode") return str(input.plan);
  return JSON.stringify(input, null, 2);
}

function questionInputs(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) throw new Error("Invalid AskUserQuestion input");
  return input.questions.map(value => {
    const q = object(value);
    if (!q || typeof q.question !== "string" || typeof q.header !== "string" || typeof q.multiSelect !== "boolean" || !Array.isArray(q.options)) throw new Error("Invalid AskUserQuestion question");
    const options = q.options.map(value => {
      const option = object(value);
      if (!option || typeof option.label !== "string" || typeof option.description !== "string") throw new Error("Invalid AskUserQuestion option");
      return { label: option.label, description: option.description };
    });
    return { question: q.question, header: q.header, multiSelect: q.multiSelect, options };
  });
}

/**
 * The card a Remote Control request deserves: a plan, a question the phone can answer, or a plain
 * tool approval — the same split the host's own canUseTool makes. A question input the phone cannot
 * render stays a tool card (the request is still answerable) rather than failing the stream.
 */
function bridgeRequest(tool: string, input: Record<string, unknown>): { requestKind: "tool" | "plan" | "question"; questions?: Question[] } {
  if (tool === "ExitPlanMode") return { requestKind: "plan" };
  if (tool !== "AskUserQuestion") return { requestKind: "tool" };
  try { return { requestKind: "question", questions: questionInputs(input) }; } catch { return { requestKind: "tool" }; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One id may only ever name one message. This is the content a receipt remembers, so a reused id
 * with other words or other files is refused instead of being answered with a success. */
const SAME_ID_OTHER_CONTENT = "같은 메시지 ID에 다른 내용이 이미 접수되었습니다. 새 메시지로 다시 보내 주세요.";
/** The first message of a session the app is starting through its folder environment (2026-10-27). */
const ENVIRONMENT_STARTING = "Claude 앱에서 세션을 시작하고 있습니다.";
const ENVIRONMENT_UNKNOWN = "Claude 앱에서 세션 생성이나 첫 메시지 전송 결과를 확인할 수 없습니다. Claude 앱에서 확인한 뒤 대기 중인 메시지를 다시 보내거나 삭제해 주세요.";
const MOD_UNKNOWN = "Claude 앱에 메시지가 전송되었는지 확인할 수 없습니다. Claude 앱에서 확인한 뒤 필요하면 다시 보내 주세요.";
const ENVIRONMENT_MODE = "선택한 권한 모드를 Claude 앱에 적용하지 못해 첫 메시지를 전송하지 않았습니다. Claude 앱에서 권한 모드를 확인한 뒤 다시 보내 주세요.";
const APP_STOP = "이 세션은 Claude 앱에서 실행 중입니다. Claude 앱에서 직접 중지해 주세요.";
/** The stricter permission mode the person picked was not confirmed by the app's worker. */
class EnvironmentModeError extends Error {}
const MOD_CLAIMED = "Claude 앱에서 메시지를 처리하고 있습니다. 처리가 완료된 후 다시 시도해 주세요.";
/** A lane item checks its token before every outgoing call; a setting change also checks it after
 * each await before recording. A message already handed on records its outcome regardless. */
type LaneToken = { check(): void };
/** How long one lane item may hold the items behind it, counted from when it starts. */
const LANE_ITEM_MS = 15_000;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sendFingerprint(text: string, attachments: Attachment[]): string {
  return digest({ text, attachments: attachments.map(a => [a.name, a.mediaType, a.blob.length]) });
}
function createFingerprint(req: { cwd: string; model: string; effort: Effort | null; text: string; permissionMode?: PermissionMode; isolation?: Isolation; baseBranch?: string }): string {
  return digest({ cwd: req.cwd, model: req.model, effort: req.effort, text: req.text, mode: req.permissionMode ?? "auto", isolation: req.isolation ?? "local", branch: req.baseBranch ?? null });
}
/** A stable v4-shaped UUID for a phone message id. */
function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The list-level state the host keeps outside any session's log: who wants a look, what is archived,
 * and up to which activity the phone has read each session (the app's unread dot is its own file,
 * which the host only reads — so the phone's reading is remembered here). */
export interface ListState { attention: Record<string, Attention>; archived: string[]; readAt: Record<string, number> }

/**
 * The attention a state change should leave behind, or null when it should leave none.
 *   waiting  → permission (a person must answer; opening the session does not clear it)
 *   error    → failed     (the last turn errored)
 *   idle, after a turn that ran → finished (the turn ended and nobody has looked yet)
 *   running/starting/stopped   → none (work (re)started, or the pending turn is gone)
 * Any other transition keeps what is already there.
 */
export function nextAttention(current: Attention | null, from: SessionState, to: SessionState, at: number): Attention | null {
  if (from === to) return current;
  if (to === "waiting") return current?.reason === "permission" ? current : { reason: "permission", at };
  if (to === "error") return current?.reason === "failed" ? current : { reason: "failed", at };
  if (to === "idle" && (from === "running" || from === "waiting")) return { reason: "finished", at };
  if (to === "running" || to === "starting" || to === "stopped") return null;
  return current;
}

/** Mac sessions the host asks the router about for the first time in one desktop poll. */
const FIRST_SIGHTS_PER_POLL = 4;
/** A turn is under way: a queued message waits. */
const BUSY = new Set<SessionState>(["starting", "running", "waiting"]);
/** The SDK's model key without the `@effort` a routed model carries. */
const windowKey = (model: string): string => model.replace(/@[^@]*$/, "");

export class Sessions {
  private opts: SessionsOptions;
  private records = new Map<string, SessionRecord>();
  /** Unreadable sessions stay on disk but cannot participate in this host's work. */
  private skippedRecords = new Map<string, SessionRecord>();
  private logs = new Map<string, EventLog>();
  private live = new Map<string, Live>();
  /** A closed SDK may still be writing its transcript until its process exits. */
  private closing = new Map<string, Live>();
  private modEchoes = new Map<string, { id: string; text: string; expires: number }>();
  /** Slash commands per session (its init event), and the latest seen anywhere for sessions with none yet. */
  private commandLists = new Map<string, { at: number; list: string[] }>();
  private lastCommands: string[] = [];
  private figuresAt = new Map<string, { at: number; model: string; epoch: string; cliId: string }>();
  private lastFigures = new Map<string, string>();
  /** model → the context window the SDK reported for it (`modelUsage`), learned from host sessions and
   * reused for Mac sessions on the same model, which never report one. Kept in `context-windows.json`. */
  private windows = new Map<string, number>();
  private windowsFile: string;
  /** Mac sessions with no record here: the latest figures read, put back into the snapshot a phone reads. */
  private desktopFigures = new Map<string, Figures>();
  /** Mac session → whether a turn was running at the last poll; absent until the session is first seen. */
  private macTurns = new Map<string, boolean>();
  private creating = new Map<string, Promise<string>>();
  private handingOff = new Map<string, { messages: SdkUserMessage[] }>();
  private shuttingDown = false;
  private file: string;
  /** Attention per session id, archived session ids, and the activity each phone read up to; kept
   * outside the logs so all three survive a restart. */
  private attention = new Map<string, Attention>();
  private archived = new Set<string>();
  private readAt = new Map<string, number>();
  private listFile: string;
  private now: () => number;
  private receipts: MessageReceipts;
  private settings: SessionSettings;
  private permissionRules = new Map<string, ReturnType<typeof sessionPermissionRules>>();
  private sendQueue: SendQueue;
  readonly modInbox: ModInbox;
  readonly settingsJobs: SettingsJobs;
  private desktopSettings: DesktopSettings | null;
  private adoptionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private modOwners = new Map<string, string>();
  /** In-flight turns keyed by receipt key, so a concurrent resend rides the first attempt. */
  private sending = new Map<string, Promise<string>>();
  private desktop: DesktopSessions | null;
  private sidebar: DesktopSidebar | null;
  private sidebarFingerprint = "";
  private desktopModels = new Map<string, { model: string; effort: Effort | null }>();
  private bridge: BridgeClient;
  private bridgeStates = new Map<string, { at: number; state?: SessionState; pending?: Promise<void> }>();
  /** Ignore cached/in-flight idle and eventual-consistency idle after an accepted send. A fresh
   * running/waiting read or transcript result settles it. The 9 s bound covers the 3 s cache,
   * 3 s poll and one scheduling margin, without leaving a never-started turn running forever. */
  private bridgeRunning = new Map<string, number>();
  private attached = new Set<string>();
  private detachedWatches = new Set<string>();
  private transcriptWatches = new Map<string, { close: (() => void) | null; timer: ReturnType<typeof setTimeout> | null }>();
  /** The last state seen per non-bridged Mac session, for the away-alert transitions. The first
   * sight of a session only seeds it: a host start must not push for turns that ended before it. */
  private macStates = new Map<string, { state: SessionState; permission: boolean }>();
  /** Claude app sessions: the status line read from the transcript at `size`. Recomputed only when
   * that file grew, so a poll never rereads a transcript it has already read (a 256 KB window). */
  private statuses = new Map<string, { size: number; status: string }>();
  /** The wrap_up whose blocked question the person was already told about, per session, so a later
   * poll that still finds the same question (or a phone that cleared it) raises it only once. */
  private askedWrapUps = new Map<string, string>();

  /** The registry says busy (it counts background work) while the main turn itself is not running. */
  private background(process: DesktopProcess): boolean {
    const state = this.bridgeState(process);
    return (process.status === "busy" || process.status === "shell") && state !== "running" && state !== "waiting";
  }

  private bridgeState(process: DesktopProcess, bridgeId = process.bridgeSessionId): SessionState {
    const id = bridgeId;
    const sent = id ? this.bridgeRunning.get(id) : undefined;
    if (sent !== undefined && this.now() - sent < 9000) return "running";
    if (id) this.bridgeRunning.delete(id);
    const cached = id ? this.bridgeStates.get(id)?.state : undefined;
    return cached ?? (process.status === "waiting" ? "waiting" : process.status === "idle" ? "idle" : "running");
  }

  private environmentState(r: SessionRecord): SessionState {
    const id = r.environmentBridgeId!;
    const sent = this.bridgeRunning.get(id);
    if (sent !== undefined && this.now() - sent < 9000) return "running";
    return this.bridgeStates.get(id)?.state ?? r.state;
  }

  private pollBridgeState(id: string): Promise<void> {
    const cached = this.bridgeStates.get(id);
    if (cached?.pending) return cached.pending;
    if (cached && this.now() - cached.at < 3000) return Promise.resolve();
    const entry: { at: number; state?: SessionState; pending?: Promise<void> } = { at: this.now(), ...(cached?.state ? { state: cached.state } : {}) };
    this.bridgeStates.set(id, entry);
    let changed = false;
    entry.pending = this.bridge.session(id).then(session => {
      this.noteBridge(id, null);
      const next: SessionState = session.worker_status === "requires_action" ? "waiting" : session.worker_status;
      const sent = this.bridgeRunning.get(id);
      // A request started before the send cannot confirm the new turn, even if it resolves later.
      if (sent !== undefined && entry.at > sent && next !== "idle") this.bridgeRunning.delete(id);
      // Phones are told only when the state actually moved; every desktop poll re-reads this.
      if (entry.state !== next) { entry.state = next; changed = true; }
    }).catch(error => {
      if (entry.state !== undefined) { delete entry.state; changed = true; } // The registry is the fallback only on a failed read.
      this.noteBridge(id, error, "desktop state");
    }).finally(() => { delete entry.pending; if (changed) this.opts.onSessions(); });
    return entry.pending;
  }

  /** Why Claude app sessions cannot be reached at all right now (the Mac's Claude login), or null. */
  private bridgeProblem: string | null = null;
  /** The last error logged per Remote Control session, so a poll that keeps failing logs once. */
  private bridgeErrors = new Map<string, string>();

  desktopProblem(): string | null { return this.bridgeProblem; }

  /**
   * Record how a Remote Control request went. Every poll re-asks, so the log gets a line when
   * something changes, not per request (an expired login wrote one every few seconds per session,
   * 2026-10-15). A login problem is the host's, not a session's: phones are told through
   * onDesktopProblem, and it clears on the first request that succeeds.
   */
  private noteBridge(bridgeId: string, error: unknown, label = "desktop state"): void {
    const log = this.opts.log ?? console.error;
    if (error === null) {
      this.bridgeErrors.delete(bridgeId);
      if (this.bridgeProblem === null) return;
      this.bridgeProblem = null;
      log("[desktop] Claude app sessions answer again");
      this.opts.onDesktopProblem?.(null);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BridgeAuthError) {
      if (this.bridgeProblem === message) return;
      this.bridgeProblem = message;
      log(`[desktop] Claude app sessions cannot be reached: ${message}`);
      this.opts.onDesktopProblem?.(message);
      return;
    }
    if (this.bridgeErrors.get(bridgeId) === message) return;
    this.bridgeErrors.set(bridgeId, message);
    if (this.bridgeErrors.size > 200) this.bridgeErrors.delete(this.bridgeErrors.keys().next().value!);
    log(`[${label}] ${bridgeId}: ${message}`);
  }
  private bridges = new Map<string, { bridgeId: string; abort: AbortController; failed: boolean; permissions: Map<string, BridgePending> }>();
  private bridgeSends = new Map<string, Promise<string>>();
  /** uuids of prompts sent over Remote Control, so their transcript echo is not shown twice. */
  private bridgeEchoes = new Set<string>();
  /** Cap for bridgeEchoes: prompts are answered or superseded long before this many pile up. */
  private static readonly ECHO_CAP = 500;
  /** Bridge requestIds already answered or withdrawn (`${session}/${requestId}` → noted at),
   * so a replay that still lists them skips them instead of reviving the card. Never forgotten with
   * time: a Remote Control session can keep listing a request the desktop app answered (the answer
   * may never reach its stored events), and a replay an hour later revived the card (issue #82). */
  private answeredBridge = new Map<string, number>();
  private static readonly ANSWERED_CAP = 2_000;
  /** Recent phone message ids per session, so resend checks skip the log scan while warm. */
  private seenIds = new Map<string, Set<string>>();
  private static readonly SEEN_INDEX_CAP = 200;
  /** Transcript size when a bridged record's title was last refreshed (a Mac rename appends). */
  private bridgeTitleSize = new Map<string, number>();
  private bridgeDecisions = new Map<string, Promise<boolean>>();

  constructor(opts: SessionsOptions) {
    this.opts = opts;
    this.settingsJobs = new SettingsJobs(30_000, opts.settingsJobExpiryMs ?? 600_000, (job, outcome) => this.finishAppSettings(job, outcome));
    this.bridge = opts.bridgeClient ?? new BridgeClient();
    this.now = opts.now ?? Date.now;
    this.file = path.join(opts.dir, "sessions.json");
    this.listFile = path.join(opts.dir, "list-state.json");
    this.windowsFile = path.join(opts.dir, "context-windows.json");
    try {
      for (const [model, window] of Object.entries(readJson<Record<string, unknown>>(this.windowsFile) ?? {})) if (typeof window === "number" && window > 0) this.windows.set(model, window);
    } catch { /* a damaged file only means the windows are learned again */ }
    this.receipts = MessageReceipts.open(path.join(opts.dir, "receipts.json"), this.now);
    this.settings = new SessionSettings(path.join(opts.dir, "settings-operations.json"));
    this.sendQueue = SendQueue.open(opts.dir);
    this.modInbox = new ModInbox(offer => {
      const id = this.modOwners.get(offer.itemId);
      if (!id || this.shuttingDown || this.sendQueue.held(id)) return false;
      const claimed = this.sendQueue.claimMod(id, offer.itemId);
      if (claimed) {
        this.rememberModEcho(id, offer);
        this.opts.onSessions();
      }
      return claimed;
    }, (offer, outcome) => this.finishMod(offer, outcome), opts.modResultMs);
    this.sendQueue.retryFailures("Claude 앱에서 열려 있는 세션에 지금은 보낼 수 없습니다.", DESKTOP_WAITING);
    this.sendQueue.retryFailures(DESKTOP_BLOCKED, DESKTOP_WAITING);
    for (const r of readJson<SessionRecord[]>(this.file) ?? []) this.records.set(r.id, r);
    const listState = readJson<ListState>(this.listFile);
    for (const [id, attention] of Object.entries(listState?.attention ?? {})) if (attention?.reason) this.attention.set(id, attention);
    for (const id of listState?.archived ?? []) this.archived.add(id);
    for (const [id, at] of Object.entries(listState?.readAt ?? {})) if (typeof at === "number" && Number.isFinite(at)) this.readAt.set(id, at);
    // On a Mac the sidebar option carries no root (the app's default folder is meant): a null here
    // switched every model/effort sync off in production while the tests, which pass a root, passed.
    this.desktopSettings = opts.desktopSidebar || opts.environmentRoot ? new DesktopSettings(opts.desktopSidebar?.root ?? opts.environmentRoot, this.now) : null;
    this.sidebar = opts.desktopSidebar ? new DesktopSidebar({ ...opts.desktopSidebar, now: this.now,
      onError: error => (opts.log ?? console.error)(`[desktop sidebar] ${error instanceof Error ? error.message : String(error)}`),
    }) : null;
    this.desktop = opts.desktopProjects === undefined ? null : new DesktopSessions({
      ...(this.sidebar ? { sidebarIds: () => new Set(this.sidebar!.read().sessions.keys()) } : {}),
      projects: opts.desktopProjects, now: this.now, summarize, figures: id => this.desktopFigures.get(id), userId: (id, uuid, text) => this.appUserId(id, uuid, text),
      ...(opts.desktopProcesses ? { processes: opts.desktopProcesses } : {}),
      ...(opts.desktopRegistry ? { registry: opts.desktopRegistry } : {}),
      // Only transcripts the host is writing right now, or a phone session not yet handed to the
      // desktop app, are hidden; any other one may be open in the app and must stay reachable
      // (a record the host once resumed is rebased onto Remote Control from here).
      excluded: () => new Set(Array.from(this.records.values()).filter(r => !r.desktopBridge && (this.live.has(r.id) || r.desktopHandoff === "pending" || r.desktopHandoff === "failed")).flatMap(r => r.sdkSessionId ? [r.id, r.sdkSessionId] : [r.id])),
    });
  }

  requestAppSettings(cliSessionId: string, settings: { model?: string; effort?: Effort }): boolean {
    const appSessionId = this.desktopSettings?.appSessionIdFor(cliSessionId);
    if (!appSessionId) return false;
    this.settingsJobs.request({ jobId: randomUUID(), appSessionId, cliSessionId, ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.effort === undefined ? {} : { effort: settings.effort }), createdAt: this.now() });
    return true;
  }

  private queueAppChoice(id: string, cliId: string, model: string, effort: Effort | null): boolean {
    const app = this.desktopSettings?.appSettingsFor(cliId);
    const record = this.records.get(id);
    if (!app || !record) return false;
    const valid = settingsModel(model);
    if (valid && !this.requestAppSettings(cliId, { model, ...(settingsEffort(effort) ? { effort } : {}) })) return false;
    const jobId = valid ? this.settingsJobs.status(app.appSessionId)!.jobId : randomUUID();
    const guard: AppSettingsGuard = { jobId, model, effort, baselineEffort: app.effort, outcome: valid ? "pending" : "failed" };
    record.appSettingsGuard = guard; record.appSettingsBirthRequested = true; this.save();
    if (!valid) this.finishAppSettings({ jobId, appSessionId: app.appSessionId, cliSessionId: cliId, createdAt: this.now() }, "failed");
    return true;
  }

  private finishAppSettings(job: SettingsJob, outcome: SettingsJobOutcome): void {
    if (this.shuttingDown) return;
    const record = [...this.records.values()].find(r => r.sdkSessionId === job.cliSessionId);
    const id = record?.id ?? job.cliSessionId;
    const guard = record?.appSettingsGuard;
    if (guard?.jobId === job.jobId) {
      guard.outcome = outcome === "applied" ? "applied" : "failed";
      if (record) this.save();
    }
    if ((outcome === "failed" || outcome === "no-helper") && this.has(id)) {
      this.append(id, { kind: "notice", code: "desktop_settings_failed", text: "Claude 앱에 모델이나 추론 강도 설정을 적용하지 못했습니다. Claude 앱에서 직접 변경해 주세요." }, false);
      this.opts.onSessions();
    }
  }

  private syncAppSettings(id: string, app: AppSettings): void {
    const record = this.records.get(id);
    const guard = record?.appSettingsGuard;
    if (this.settingsJobs.hasPending(app.appSessionId) || this.sessionLanes.has(id)) return;
    // A restarted host lost its in-memory job; it cannot know whether the helper applied it.
    if (guard?.outcome === "pending") {
      guard.outcome = "failed";
      if (record) this.save();
      this.append(id, { kind: "notice", code: "desktop_settings_failed", text: "Claude 앱에 모델이나 추론 강도 설정이 적용되었는지 확인할 수 없습니다. Claude 앱에서 확인한 뒤 필요하면 직접 변경해 주세요." }, false);
      this.opts.onSessions();
    }
    const modelAllowed = !guard || guard.modelObserved || app.model === guard.model;
    const effortAllowed = !guard || guard.effortObserved || settingsEffort(guard.effort) && app.effort === guard.effort ||
      !settingsEffort(guard.effort) && settingsEffort(app.effort) && app.effort !== guard.baselineEffort;
    const current = record ?? this.desktopModels.get(id) ?? this.desktop?.list().find(s => s.id === id);
    if (!current) return;
    const model = modelAllowed && app.model ? app.model : current.model;
    const effort = effortAllowed && settingsEffort(app.effort) ? app.effort : current.effort;
    if (guard) {
      const changed = !!app.model && !!modelAllowed && !guard.modelObserved || settingsEffort(app.effort) && !!effortAllowed && !guard.effortObserved;
      if (app.model && modelAllowed) guard.modelObserved = true;
      if (settingsEffort(app.effort) && effortAllowed) guard.effortObserved = true;
      if (guard.modelObserved && guard.effortObserved) {
        if (record) delete record.appSettingsGuard;
      }
      if (record && changed) this.save();
    }
    if (model === current.model && effort === current.effort) return;
    if (record) {
      if (model !== record.model) record.contextWindow = null;
      record.model = model; record.effort = effort;
      record.confirmedSettings = { ...record.confirmedSettings, model, effort };
      this.save();
    } else this.desktopModels.set(id, { model, effort });
    this.opts.onSessions();
  }

  private syncDesktopSettings(): void {
    for (const record of this.records.values()) {
      const cliId = record.sdkSessionId;
      if (!cliId) continue;
      const app = this.desktopSettings?.appSettingsFor(cliId);
      if (!app) continue;
      if (!record.appSettingsBirthRequested && (record.environmentBridgeId || record.desktopHandoff === "attempted")) {
        this.queueAppChoice(record.id, cliId, record.model, record.effort);
      }
      this.syncAppSettings(record.id, app);
    }
    const hostIds = new Set([...this.records.values()].flatMap(r => r.sdkSessionId ? [r.id, r.sdkSessionId] : [r.id]));
    for (const session of this.desktop?.list() ?? []) {
      if (hostIds.has(session.id)) continue;
      const app = this.desktopSettings?.appSettingsFor(session.id);
      if (app) this.syncAppSettings(session.id, app);
    }
  }

  /** After a host restart: no query survived, so say so in every session that was mid-turn, and close what it was asking. */
  recover(): void {
    this.sendQueue.recoverMod(MOD_UNKNOWN);
    // Validate even idle sessions: listing one also opens its log. Isolate failures before
    // recovery appends anything, and retain their records when healthy sessions are saved.
    for (const r of this.records.values()) {
      try { this.log(r.id); }
      catch (error) {
        this.skippedRecords.set(r.id, r);
        this.records.delete(r.id);
        (this.opts.log ?? console.error)(`[session recovery] skipped ${r.id}: ${error instanceof Error ? error.message : String(error)}; session files preserved at ${path.join(this.opts.dir, "sessions", r.id)}`);
      }
    }
    for (const operation of this.settings.unresolved()) {
      if (this.has(operation.session)) this.append(operation.session, { kind: "settings", reqId: operation.reqId, status: "unknown" }, false);
    }
    for (const p of this.opts.permissions.expiredOnOpen) {
      if (this.records.has(p.session)) this.append(p.session, { kind: "permission_decided", id: p.id, decision: "expired", reason: "host_restarted" });
    }
    for (const r of this.records.values()) {
      if (!r.desktopBridge && r.desktopHandoff !== "attempted") this.invalidateActivity(r.id);
      // A host exit during the launcher call did not confirm delivery to Desktop.
      if (r.desktopHandoff === "opening") {
        r.desktopHandoff = (r.desktopHandoffAttempts ?? 0) < 3 ? "pending" : "failed";
        this.save();
        if (r.desktopHandoff === "failed") this.append(r.id, { kind: "notice", code: "desktop_handoff_failed" }, false);
      }
      // An environment creation the host exit cut short: its first message may or may not have gone.
      if (r.environmentCreateUnknown || r.environmentBridgeId) {
        for (const item of this.sendQueue.items(r.id)) if (item.error === ENVIRONMENT_STARTING) this.sendQueue.fail(r.id, item.id, ENVIRONMENT_UNKNOWN);
      }
      if (r.state === "running" || r.state === "starting" || r.state === "waiting") {
        this.append(r.id, { kind: "notice", code: "host_restarted", text: "호스트가 다시 시작되어 이 턴이 중단되었습니다" }, false);
        this.setState(r, "stopped", undefined, false);
      }
    }
  }

  list(): SessionSummary[] {
    this.adoptEnvironmentSessions();
    const host = Array.from(this.records.values()).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => this.summary(r));
    const hostCliIds = new Set([...this.records.values(), ...this.skippedRecords.values()].flatMap(r => r.sdkSessionId ? [r.id, r.sdkSessionId] : [r.id]));
    const sessions = [...host, ...(this.desktop?.list() ?? []).filter(s => !this.records.has(s.id) && !hostCliIds.has(s.id)).map(s => {
      const process = this.desktop?.liveProcess(s.id);
      const status = this.statusLine(s.id);
      return { ...s, ...this.desktopModels.get(s.id), controls: this.sessionControls(s.id), ...(process?.bridgeSessionId ? { state: this.bridgeState(process), desktopBridge: true, background: this.background(process) } : {}), ...(this.archived.has(s.id) ? { archived: true } : {}), attention: this.attention.get(s.id) ?? null, ...(status ? { status } : {}), ...this.queueSummary(s.id) };
    })];
    const listed = this.sidebar?.join(sessions, id => this.records.get(id)?.sdkSessionId ?? id, id => !!this.records.get(id)?.environmentBridgeId) ?? sessions;
    // A session the list no longer holds keeps no read record (this map must not outgrow the list).
    const present = new Set(listed.map(s => s.id));
    let pruned = false;
    for (const id of [...this.readAt.keys()]) if (!present.has(id)) { this.readAt.delete(id); pruned = true; }
    if (pruned) this.saveListState();
    // Reading on the phone clears the Mac app's unread dot: a look after the last activity outranks
    // the app's late-written unread set (sidebar.ts:98). Newer activity outruns the record again.
    return listed.map(s => s.unread && (this.readAt.get(s.id) ?? 0) >= s.updatedAt ? { ...s, unread: false } : s);
  }

  groups(): string[] | undefined {
    return this.sidebar ? [...this.sidebar.read().groups.map(g => g.name), PHONE_GROUP] : undefined;
  }

  private adoptEnvironmentSessions(): void {
    for (const r of this.records.values()) {
      if (!r.environmentBridgeId || r.sdkSessionId) continue;
      const process = this.desktop?.processForBridge(r.environmentBridgeId);
      if (process) { r.sdkSessionId = process.sessionId; this.save(); }
    }
  }

  private pollEnvironmentAdoption(r: SessionRecord): void {
    if (this.adoptionTimers.has(r.id) || this.shuttingDown) return;
    const deadline = performance.now() + 30_000;
    const tick = () => {
      this.adoptionTimers.delete(r.id);
      if (this.shuttingDown || performance.now() >= deadline) return;
      try {
        this.adoptEnvironmentSessions();
        if (r.sdkSessionId && this.desktop?.transcriptEnd(r.sdkSessionId) !== undefined) {
          this.syncDesktopSettings();
          this.watchDesktop(r.id);
          this.tailBridge(r);
          this.opts.onSessions();
          return;
        }
      } catch (error) { (this.opts.log ?? console.error)(`[environment adoption] ${r.id}: ${String(error)}`); }
      const timer = setTimeout(tick, 300);
      timer.unref();
      this.adoptionTimers.set(r.id, timer);
    };
    tick();
  }

  async pollDesktop(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.desktop?.poll()) this.opts.onSessions();
    this.adoptEnvironmentSessions();
    this.syncDesktopSettings();
    this.refreshStatuses();
    const sessions = this.list();
    this.pollMacAlerts(sessions);
    if (this.sidebar) {
      const fingerprint = JSON.stringify([this.groups(), sessions]);
      if (fingerprint !== this.sidebarFingerprint) { this.sidebarFingerprint = fingerprint; this.opts.onSessions(); }
    }
    const ids = new Set(sessions.flatMap(s => {
      const process = this.desktop?.liveProcess(this.records.get(s.id)?.sdkSessionId ?? s.id);
      const bridgeId = this.records.get(s.id)?.environmentBridgeId ?? process?.bridgeSessionId;
      return bridgeId ? [bridgeId] : [];
    }));
    const reads = [...ids].map(id => this.pollBridgeState(id));
    for (const id of this.bridgeStates.keys()) if (!ids.has(id)) this.bridgeStates.delete(id);
    for (const r of this.records.values()) {
      const live = this.live.get(r.id);
      if (live?.restartAfterTurn && this.sdkIdle(r, live)) { this.restartSettings(r, live); continue; }
      if (r.desktopHandoff === "pending" || r.desktopHandoff === "failed" && this.now() >= (r.desktopHandoffRetryAt ?? 0)) this.handoff(r);
      if (!this.desktop) continue;
      const desktopProcess = r.sdkSessionId ? this.desktop.liveProcess(r.sdkSessionId) : undefined;
      // The Claude app worker has Remote Control on for a conversation the host is still driving
      // (a phone session, or one the phone resumed): the app is the writer now. Stop our own query
      // and follow the app's transcript (#82) — together they would append to one transcript and
      // the phone would follow neither. A query still owed a turn finishes first: stopping it would
      // drop messages the phone already had acked.
      if (!r.desktopBridge && r.sdkSessionId && desktopProcess?.bridgeSessionId) {
        const live = this.live.get(r.id);
        if (this.sdkIdle(r, live)) {
          this.stop(r.id);
          // The app already has this conversation, so a pending handoff would only open it again.
          if (r.desktopHandoff === "pending" || r.desktopHandoff === "failed") {
            r.desktopHandoff = "attempted";
            delete r.desktopHandoffError;
            this.save();
          }
          if (this.desktop.has(r.sdkSessionId)) {
            try { this.rebaseDesktop(r); } catch (error) { this.bridgeFailure(r.id, error); continue; }
          }
        }
      }
      if (!r.desktopBridge) {
        if (this.canTailHandoff(r)) {
          try { this.watchDesktop(r.id); this.tailDesktop(r.id); }
          catch (error) { (this.opts.log ?? console.error)(`[desktop tail] ${r.id}: ${String(error)}`); }
          // The app's turns leave no result or state line in this log, so the queue's "awaiting" mark
          // never settled and every message after an app-run turn sat queued (2026-10-27, twice).
          // Write the app's own run state here, after the tail, as a bridged session's poll does.
          const status = this.desktop?.liveProcess(r.sdkSessionId!)?.status;
          const state: SessionState = status === "busy" || status === "shell" ? "running" : status === "waiting" ? "waiting" : "idle";
          this.setState(r, state, undefined, BUSY.has(state));
        }
        continue;
      }
      try {
        this.tailBridge(r);
        // A folder move shows only in the app's registry, not as transcript growth: check every poll.
        this.refreshBridgeMeta(r);
        const process = this.desktop.liveProcess(r.sdkSessionId ?? r.id);
        const bridgeId = r.environmentBridgeId ?? process?.bridgeSessionId;
        const state = process ? this.bridgeState(process, bridgeId) : r.environmentBridgeId ? this.environmentState(r) : "stopped";
        if (!r.environmentBridgeId || r.state !== "error") this.setState(r, state, undefined, !!process);
        if (bridgeId) this.ensureBridge(r.id, bridgeId);
        else this.closeBridge(r.id);
      } catch (error) { this.bridgeFailure(r.id, error); }
    }
    await Promise.all(reads);
    if (this.shuttingDown) return;
    for (const r of this.records.values()) {
      if (!r.desktopBridge) continue;
      const process = this.desktop?.liveProcess(r.sdkSessionId ?? r.id);
      const bridgeId = r.environmentBridgeId;
      const state = process ? this.bridgeState(process, bridgeId) : bridgeId ? this.environmentState(r) : "stopped";
      if (!bridgeId || r.state !== "error") this.setState(r, state, undefined, !!process);
    }
    for (const id of this.attached) {
      this.watchDesktop(id);
      if (!this.records.get(id)?.desktopBridge) this.tailDesktop(id);
    }
    this.pollMacFigures(sessions);
    this.drainQueues();
  }

  /** The server supplies the union across phones; one phone detaching must not close another's watch. */
  watchAttached(ids: Set<string>): void {
    for (const id of this.attached) if (!ids.has(id)) { this.detachedWatches.add(id); this.unwatchDesktop(id); }
    this.attached = new Set(ids);
    for (const id of ids) { this.detachedWatches.delete(id); this.watchDesktop(id); }
  }

  private canTailHandoff(r: SessionRecord): boolean {
    return !!r.sdkSessionId && r.desktopHandoff === "attempted" && !r.desktopBridge && !r.environmentBridgeId && !r.environmentCreateUnknown &&
      !this.live.has(r.id) && !this.closing.has(r.id) && !this.handingOff.has(r.id) && !this.desktop?.liveProcess(r.sdkSessionId)?.bridgeSessionId;
  }

  private watchDesktop(id: string): void {
    const record = this.records.get(id);
    const desktopId = record?.sdkSessionId ?? id;
    if (this.shuttingDown || this.detachedWatches.has(id) || this.transcriptWatches.has(id) || (record && !record.desktopBridge && !this.canTailHandoff(record)) || !this.desktop?.has(desktopId)) return;
    if (record?.desktopBridge && !this.desktop.liveProcess(desktopId)?.bridgeSessionId) return;
    const entry = { close: null as (() => void) | null, timer: null as ReturnType<typeof setTimeout> | null };
    this.transcriptWatches.set(id, entry);
    const changed = () => {
      if (this.transcriptWatches.get(id) !== entry || entry.timer) return;
      // Fixed window rather than a trailing debounce: continuous writes cannot starve delivery.
      entry.timer = setTimeout(() => {
        entry.timer = null;
        try { this.tailDesktop(id); }
        catch (error) { (this.opts.log ?? console.error)(`[desktop tail] ${id}: ${String(error)}`); }
      }, 80);
    };
    const failed = (error: unknown) => {
      (this.opts.log ?? console.error)(`[desktop watch] ${id}: ${String(error)}; polling continues`);
      this.unwatchDesktop(id);
    };
    entry.close = this.opts.watchTranscript
      ? this.opts.watchTranscript(desktopId, changed, failed)
      : this.desktop.watch(desktopId, changed, failed);
    if (!entry.close) this.unwatchDesktop(id);
  }

  private unwatchDesktop(id: string): void {
    const entry = this.transcriptWatches.get(id);
    if (!entry) return;
    this.transcriptWatches.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.close?.();
  }

  private tailDesktop(id: string): void {
    const r = this.records.get(id);
    if (r?.desktopBridge) { this.tailBridge(r); return; }
    if (r) {
      if (!this.canTailHandoff(r) || !this.desktop?.has(r.sdkSessionId!)) return;
      if (r.transcriptOffset === undefined) { this.markTranscriptEnd(r); return; }
      this.tailBridge(r);
      return;
    }
    if (!this.desktop?.has(id)) return;
    const before = this.desktop.snapshot(id);
    const log = this.desktop.log(id);
    if (before === log) return;
    // Read-only desktop snapshots get a new epoch when rebuilt; the server sends a fresh tail.
    const last = log.tail().events.at(-1);
    if (last) this.opts.onEvent(id, last);
    this.opts.onSessions();
  }

  private tailBridge(r: SessionRecord): void {
    if (!this.desktop) return;
    const desktopId = r.sdkSessionId ?? r.id;
    const before = r.transcriptOffset ?? 0;
    r.transcriptOffset = this.desktop.tail(desktopId, before, body => {
      if (body.kind === "result") {
        const bridgeId = r.environmentBridgeId ?? this.desktop?.liveProcess(desktopId)?.bridgeSessionId;
        if (bridgeId) this.bridgeRunning.delete(bridgeId);
      }
      // Our own Remote Control echo: drop it from the bounded set and skip it, once.
      if (body.kind === "user" && (this.bridgeEchoes.delete(body.clientMsgId) || r.environmentBridgeId && body.clientMsgId === (UUID_RE.test(r.createdBy) ? r.createdBy : uuidFrom(r.createdBy)) && this.seen(r.id, r.createdBy))) return;
      if (!r.desktopBridge && body.kind === "user" && !body.images?.length && !body.files?.length) {
        const echo = this.takeModEcho(r.id, body.text);
        if (echo) {
          if (!this.seen(r.id, echo)) {
            this.personMessage(r.id);
            this.append(r.id, { ...body, clientMsgId: echo });
            this.rememberClientMsgId(r.id, echo);
          }
          return;
        }
      }
      if (body.kind !== "user" || !this.seen(r.id, body.clientMsgId)) {
        if (body.kind === "user") this.rememberClientMsgId(r.id, body.clientMsgId);
        this.append(r.id, body);
      }
    }, data => this.log(r.id).image(data));
    if (r.transcriptOffset !== before) {
      this.save();
      if (r.desktopBridge) {
        this.refreshBridgeMeta(r);
        const process = this.desktop.liveProcess(desktopId);
        this.setState(r, process ? this.bridgeState(process) : "stopped", undefined, !!process);
      }
    }
  }

  /**
   * The mod's figures for Claude app sessions, which no SDK query of ours drives: once when a session
   * is first seen, at most every 15 s while its turn runs, and once more when the turn ends. The
   * first sights are spread over polls so a host start does not ask the router about every old session at once.
   */
  private pollMacFigures(sessions: SessionSummary[]): void {
    if (!this.desktop) return;
    const seen = new Set<string>();
    let firstSights = 0;
    for (const s of sessions) {
      const record = this.records.get(s.id);
      if (record ? !record.desktopBridge : s.origin !== "desktop") continue;
      if (s.archived || !s.model) continue;
      seen.add(s.id);
      const running = s.state === "running" || s.state === "waiting" || s.state === "starting";
      const wasRunning = this.macTurns.get(s.id);
      if (wasRunning === undefined && firstSights >= FIRST_SIGHTS_PER_POLL) continue;
      this.macTurns.set(s.id, running);
      if (wasRunning === undefined) firstSights++;
      const previous = this.figuresAt.get(s.id);
      // First materialization is not a replacement: no older snapshot existed to invalidate.
      if (previous && !previous.epoch) previous.epoch = s.epoch;
      const changed = previous && (previous.model !== s.model || s.epoch && previous.epoch !== s.epoch);
      if (wasRunning === undefined || wasRunning || running || changed) {
        const forced = wasRunning === undefined || (wasRunning && !running) || !!changed;
        void this.readFigures(s.id, record?.sdkSessionId ?? s.id, s.model, record?.contextWindow ?? null, forced, true);
      }
    }
    for (const id of this.macTurns.keys()) {
      if (seen.has(id)) continue;
      this.macTurns.delete(id);
      if (this.records.has(id)) continue;
      this.figuresAt.delete(id); this.lastFigures.delete(id); this.desktopFigures.delete(id);
    }
  }

  /**
   * The Claude app's own sidebar line for each of its sessions: the last wrap_up's recap, first
   * sentence only. Read from the transcript's tail window, and only when that file grew; the list is
   * re-sent only when a line actually changed, so an idle poll costs nothing.
   */
  private refreshStatuses(): void {
    if (!this.desktop) return;
    let changed = false;
    const seen = new Set<string>();
    for (const s of this.desktop.list()) {
      const record = this.records.get(s.id);
      if (record ? !record.desktopBridge : s.origin !== "desktop") continue;
      if (this.archived.has(s.id)) continue;
      seen.add(s.id);
      const size = this.desktop.transcriptSize(s.id);
      const cached = this.statuses.get(s.id);
      if (cached && cached.size === size) continue;
      const wrap = this.desktop.wrapUp(s.id);
      const status = wrap ? firstSentence(wrap.recap, STATUS_CAP) : "";
      this.statuses.set(s.id, { size, status });
      if ((cached?.status ?? "") !== status) changed = true;
    }
    for (const id of this.statuses.keys()) if (!seen.has(id)) this.statuses.delete(id);
    if (changed) this.opts.onSessions();
  }

  private statusLine(id: string): string | null { return this.statuses.get(id)?.status || null; }

  /** The wrap_up a Claude app session's newest turn left; null for any session the app does not own. */
  private desktopWrapUp(id: string): TurnWrapUp | null {
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    return this.desktop?.has(desktopId) ? this.desktop.wrapUp(desktopId) : null;
  }

  /**
   * The attention a Claude app turn that stopped on a blocked question leaves: the person's answer is
   * what resumes it. Raised once per wrap_up — a phone's `seen` clears it, and a poll that still
   * finds the same question does not put it back. `wrap` is a reading the caller already has.
   */
  private questionAttention(id: string, from: SessionState, to: SessionState, wrap?: TurnWrapUp | null): Attention | null {
    if (to !== "idle" || (from !== "running" && from !== "waiting")) return null;
    const found = wrap === undefined ? this.desktopWrapUp(id) : wrap;
    if (!found?.ask || !found.blocked || this.askedWrapUps.get(id) === found.key) return null;
    this.askedWrapUps.set(id, found.key);
    return { reason: "question", at: this.now() };
  }

  /** The person sent this session a message: the previous turn's status line is over, and a question
   * that turn left is answered by whatever they typed. The size stays, so the still-unchanged
   * transcript is not read again for a recap the person has already moved past. */
  private personMessage(id: string): void {
    this.askedWrapUps.delete(id);
    let changed = false;
    const cached = this.statuses.get(id);
    if (cached?.status) { this.statuses.set(id, { size: cached.size, status: "" }); changed = true; }
    if (this.attention.get(id)?.reason === "question") { this.attention.delete(id); this.saveListState(); changed = true; }
    if (changed) this.opts.onSessions();
  }

  /** What the pushes should say about an event: a Claude app turn that closed on a question pushes
   * the question instead of that it finished. */
  pushEvent(id: string, event: PushEvent): PushEvent {
    if (event.kind !== "result" || !this.records.get(id)?.desktopBridge) return event;
    const wrap = this.desktopWrapUp(id);
    return wrap?.ask ? { kind: "question", ask: wrap.ask, blocked: wrap.blocked } : event;
  }

  private learnWindow(model: string, window: number): void {
    const key = windowKey(model);
    if (!(window > 0) || this.windows.get(key) === window) return;
    this.windows.set(key, window);
    try { writeFileAtomic(this.windowsFile, JSON.stringify(Object.fromEntries(this.windows))); }
    catch (error) { (this.opts.log ?? console.error)(`[context windows] not saved: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Alerts for Mac sessions the host is not tailing: a bridged record already pushes through its
   * own appended events, so this path is for the ones only the list knows. A turn that was running
   * and is now idle finished — on a question the Claude app's wrap_up left, which is what the push
   * says instead, or otherwise ok/failed as the transcript's result reports. A session that newly
   * waits for approval asks. The first sight of a session only seeds its state.
   */
  private pollMacAlerts(sessions: SessionSummary[]): void {
    if (!this.desktop) return;
    const seen = new Set<string>();
    for (const s of sessions) {
      if (s.origin !== "desktop" || this.records.has(s.id) || this.archived.has(s.id)) continue;
      seen.add(s.id);
      const permission = s.state === "waiting" || s.pending > 0;
      const previous = this.macStates.get(s.id);
      this.macStates.set(s.id, { state: s.state, permission });
      const current = this.attention.get(s.id) ?? null;
      // List-only desktop sessions have no record whose setState would retire the previous
      // turn's attention. Use the same transition contract without generating startup alerts.
      const next = nextAttention(current, previous?.state ?? "stopped", s.state, this.now());
      if (next !== current) { this.setAttention(s.id, next); this.opts.onSessions(); }
      if (!previous) continue;
      if (permission && !previous.permission) this.alert(s.id, { kind: "permission" });
      else if (previous.state === "running" && s.state === "idle") {
        const wrap = this.desktop.wrapUp(s.id);
        if (!wrap?.ask) this.alert(s.id, { kind: "result", ok: this.desktop.turnOutcome(s.id) ?? true });
        else {
          // A blocked question keeps the session on "someone must answer" until they do.
          const question = this.questionAttention(s.id, "running", "idle", wrap);
          if (question) { this.setAttention(s.id, question); this.opts.onSessions(); }
          this.alert(s.id, { kind: "question", ask: wrap.ask, blocked: wrap.blocked });
        }
      }
    }
    for (const id of this.macStates.keys()) if (!seen.has(id)) this.macStates.delete(id);
  }

  /** Hand an alert to the pushes, but only when the Mac is away: the person at the desk sees it already. */
  private alert(id: string, body: AlertBody): void {
    const { onAlert, away } = this.opts;
    if (!onAlert || !away) return;
    void away().then(awayNow => { if (awayNow) onAlert(id, body); })
      .catch(error => (this.opts.log ?? console.error)(`[alert] ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }

  has(id: string): boolean { return !this.skippedRecords.has(id) && (this.records.has(id) || (this.desktop?.has(id) ?? false)); }

  /** Archive/unarchive: only a flag. Transcripts and files are never deleted, just hidden by default. */
  setArchived(id: string, archived: boolean): boolean {
    if (!this.has(id)) throw new Error("no such session");
    const changed = archived ? !this.archived.has(id) : this.archived.has(id);
    if (changed) { if (archived) this.archived.add(id); else this.archived.delete(id); this.saveListState(); this.opts.onSessions(); }
    return changed;
  }

  /** The phone is looking at this session: clear its attention — except a permission request, which
   * only clears when the approval is answered — and remember that the phone read up to the session's
   * current activity, so the app's unread dot does not outlive the look (server.ts only forwards a
   * seen from a visibly focused phone, so a background one cannot mark anything read).
   * Reports whether anything the phone sees changed. */
  markSeen(id: string): boolean {
    let changed = false;
    const current = this.attention.get(id);
    if (current && current.reason !== "permission") { this.attention.delete(id); changed = true; }
    // Only a row the list still shows as unread needs a record: once read up to its activity, the
    // earlier timestamp stands, so a presence ping that changes nothing never rewrites list-state.json.
    const activity = this.sidebar?.unreadActivity(this.records.get(id)?.sdkSessionId ?? id);
    if (activity !== undefined && activity > (this.readAt.get(id) ?? 0)) {
      this.readAt.set(id, Math.max(this.now(), activity)); changed = true;
    }
    if (changed) { this.saveListState(); this.opts.onSessions(); }
    return changed;
  }

  /** "Mark unread": put the attention back, guessed from what the session is doing now, and forget
   * what the phone had read so the app's unread dot can show again. */
  markUnread(id: string): Attention {
    const s = this.list().find(x => x.id === id);
    if (!s) throw new Error("no such session");
    const reason: AttentionReason = s.pending > 0 || s.state === "waiting" ? "permission" : s.state === "error" ? "failed" : "finished";
    const attention: Attention = { reason, at: this.now() };
    if (this.readAt.delete(id)) this.saveListState();
    this.setAttention(id, attention);
    this.opts.onSessions();
    return attention;
  }

  /** An approval was answered; a permission attention clears once nothing else is still open. */
  private clearPermissionAttention(id: string): void {
    if (this.attention.get(id)?.reason !== "permission") return;
    if (this.opts.permissions.pending(id).length > 0) return;
    this.attention.delete(id);
    this.saveListState();
    this.opts.onSessions();
  }

  /** The slash commands the phone offers after "/": a Mac session's from its Remote Control init (re-read
   * after five minutes), a host session's from its own init; otherwise the latest list seen anywhere. */
  async commands(id: string): Promise<string[]> {
    if (!this.has(id)) throw new Error("no such session");
    const cached = this.commandLists.get(id);
    const bridgeId = this.desktop?.liveProcess(this.records.get(id)?.sdkSessionId ?? id)?.bridgeSessionId;
    if (bridgeId && (!cached || this.now() - cached.at > 300_000)) {
      try {
        const list = await this.bridge.commands(bridgeId);
        if (list) { this.commandLists.set(id, { at: this.now(), list }); this.lastCommands = list; return list; }
      } catch (error) { (this.opts.log ?? console.error)(`[commands] ${error instanceof Error ? error.message : String(error)}`); }
    }
    return cached?.list ?? this.lastCommands;
  }

  private continueDesktop(id: string, clientMsgId: string, bridgeMode = false, settingsOnly = false): SessionRecord {
    if (!this.desktop) throw new Error("no such session");
    const { summary: s, open } = this.desktop.continuation(id);
    if (open && !bridgeMode) throw new DesktopBlockedError();
    const log = this.desktop.importInto(id, path.join(this.opts.dir, "sessions", id), this.now);
    // The app's registry records the folder the conversation runs in now; the transcript's first
    // line keeps the one it started in (a conversation moved folders, issue #82).
    const cwd = this.desktop.liveProcess(id)?.cwd ?? s.cwd;
    const r: SessionRecord = { id, sdkSessionId: id, cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode ?? "default", title: s.title, createdAt: s.createdAt, updatedAt: this.now(), state: "stopped", createdBy: clientMsgId, contextWindow: null, desktopHandoff: "excluded" };
    if (bridgeMode) { r.desktopBridge = true; r.transcriptOffset = this.desktop.transcriptSize(id); }
    Object.assign(r, this.desktopModels.get(id));
    this.desktopModels.delete(id);
    this.logs.set(id, log);
    this.records.set(id, r);
    this.save();
    if (!settingsOnly) this.append(id, { kind: "notice", code: bridgeMode ? "desktop_bridge" : "desktop_resumed" });
    this.opts.onSessions();
    return r;
  }

  /** Includes accepted work whose running state is not recorded yet. */
  busy(): boolean {
    if (this.creating.size || this.sending.size || this.draining.size || this.handingOff.size) return true;
    for (const r of this.records.values()) if (BUSY.has(r.state)) return true;
    return false;
  }

  /** Reserve idle synchronously; deferred desktop/queue callbacks may not start another turn. */
  prepareRefresh(): boolean {
    if (this.shuttingDown || this.busy()) return false;
    this.shuttingDown = true;
    this.closeQueueWatch();
    return true;
  }

  summaryOf(id: string): SessionSummary | undefined {
    const r = this.records.get(id);
    if (r) return this.summary(r);
    // A Mac session the host is not tailing has no record: its push (onAlert) still needs a title.
    return this.desktop?.has(id) ? this.list().find(s => s.id === id) : undefined;
  }

  /** Only the encrypted native push path asks for private turn context. */
  async pushContext(id: string, event: PushEvent): Promise<PushContext> {
    const summary = this.summaryOf(id);
    const record = this.records.get(id);
    const context: PushContext = summary ? { title: summary.title === id ? "" : summary.title, cwd: summary.cwd } : {};
    if (event.kind === "result") {
      if (record) {
        // onEvent fires immediately after append, before a later turn can change this cursor.
        const log = this.log(id);
        const seq = "seq" in event && typeof event.seq === "number" ? event.seq : log.lastSeq;
        context.text = log.lastAssistantText(seq);
      } else Object.assign(context, this.desktop?.pushContext(id));
    }
    if (event.kind === "permission" && !("tool" in event)) {
      const bridgeId = this.desktop?.liveProcess(record?.sdkSessionId ?? id)?.bridgeSessionId;
      if (bridgeId) {
        const request = (await this.bridge.openRequests(bridgeId))?.[0];
        if (request) { context.tool = request.tool; context.summary = summarize(request.tool, request.input, summary?.cwd ?? ""); }
      }
    }
    return context;
  }

  private sessionControls(id: string): SessionControls {
    const r = this.records.get(id);
    const desktopId = r?.sdkSessionId ?? id;
    const process = this.desktop?.liveProcess(desktopId);
    const desktop = r?.desktopBridge || this.desktop?.isOpen(desktopId);
    const enabled = !desktop || !!(r?.environmentBridgeId ?? process?.bridgeSessionId) && !this.bridgeProblem && !this.bridges.get(id)?.failed;
    const appSettings = !!this.desktopSettings?.appSessionIdFor(desktopId);
    return { model: enabled || appSettings, effort: enabled || appSettings, permissionModes: enabled ? [...PERMISSION_MODES] : [] };
  }

  /** The record keeps the requested launch choice; confirmation stays on the live query until restart. */
  private effectiveSettings(r: SessionRecord): { model: string; effort: Effort | null; pendingSettings?: SettingsResult["pending"] } {
    if (!this.live.get(r.id)?.restartAfterTurn) return { model: r.model, effort: r.effort };
    return { model: r.confirmedSettings?.model ?? r.model, effort: r.confirmedSettings?.effort ?? null,
      pendingSettings: { model: r.model, effort: r.effort } };
  }

  private summary(r: SessionRecord): SessionSummary {
    const log = this.log(r.id);
    const process = r.desktopBridge ? this.desktop?.liveProcess(r.sdkSessionId ?? r.id) : undefined;
    // A handed-off session the app is running (a mod-typed or app-typed turn): its state is the app's.
    const appRun = !r.desktopBridge && this.canTailHandoff(r) ? this.desktop?.liveProcess(r.sdkSessionId!) : undefined;
    const appState: SessionState | undefined = appRun && appRun.status !== "idle" ? (appRun.status === "waiting" ? "waiting" : "running") : undefined;
    const state = r.environmentBridgeId && r.state === "error" ? r.state : process ? this.bridgeState(process, r.environmentBridgeId ?? process.bridgeSessionId) : r.environmentBridgeId ? this.environmentState(r) : r.desktopBridge ? "stopped" : appState ?? r.state;
    // Main-turn idleness does not finish background work. Keep transcript observations separate
    // from a complete engine inventory, which only the SDK Stop hook can confirm here.
    const working = process?.status === "busy" || process?.status === "shell";
    const activity = r.desktopBridge ? null : this.taskState(r.id).activity;
    const taskList = r.desktopBridge ? this.desktop?.backgroundTaskList(r.sdkSessionId ?? r.id) ?? [] : activity?.active ?? [];
    const taskHistory = r.desktopBridge ? this.desktop?.backgroundTaskHistory(r.sdkSessionId ?? r.id) ?? [] : activity?.history ?? [];
    const turnStartedAt = working ? this.desktop?.turnStartedAt(r.sdkSessionId ?? r.id) ?? null : null;
    const plan = r.desktopBridge ? this.desktop?.plan(r.sdkSessionId ?? r.id) ?? [] : this.taskState(r.id).tracker.list;
    // The desktop launcher confirms opening, not permissions. Retain the SDK choice for a
    // future host resume, but do not advertise it as the app's current mode after handoff.
    const hostMode = this.live.has(r.id) || r.desktopHandoff !== "attempted" && r.desktopHandoff !== "opening";
    const mode = r.desktopBridge ? r.confirmedSettings?.permissionMode ?? this.desktop?.permissionMode(r.sdkSessionId ?? r.id)
      : hostMode ? r.confirmedSettings?.permissionMode ?? r.permissionMode ?? "auto" : undefined;
    const status = r.desktopBridge ? this.statusLine(r.id) : null;
    return { plan, tasks: taskList.length, taskList, taskHistory, backgroundKnown: activity?.known ?? false, activityAt: activity?.at ?? null, ...(r.desktopBridge ? { desktopBridge: true, turnStartedAt, ...(process ? { background: this.background(process) } : {}) } : {}), origin: "host", readOnly: false, controls: this.sessionControls(r.id), id: r.id, title: r.title, cwd: r.cwd, ...this.effectiveSettings(r), ...(mode ? { permissionMode: mode } : {}), ...(status ? { status } : {}), state, pending: this.opts.permissions.pending(r.id).length, ...this.queueSummary(r.id), ...(this.archived.has(r.id) ? { archived: true } : {}), attention: this.attention.get(r.id) ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt, lastSeq: log.lastSeq, epoch: log.epoch };
  }

  log(id: string): EventLog {
    if (this.skippedRecords.has(id)) throw new Error("Session log is unreadable; session skipped during recovery");
    if (!this.records.has(id)) {
      const process = this.desktop?.liveProcess(id);
      if (process?.bridgeSessionId && this.desktop?.has(id)) {
        this.continueDesktop(id, "", true);
        this.ensureBridge(id, process.bridgeSessionId);
        return this.logs.get(id)!;
      }
      if (this.desktop?.has(id)) return this.desktop.log(id);
      throw new Error("no such session");
    }
    let log = this.logs.get(id);
    if (!log) { log = EventLog.open({ dir: path.join(this.opts.dir, "sessions", id), now: this.now }); this.logs.set(id, log); }
    return log;
  }

  subLog(id: string, sub: string): EventLog | null {
    if (!/^sub-[\w-]{1,80}$/.test(sub)) return null;
    const record = this.records.get(id);
    // A Mac (Claude app) session's worker log lives beside its transcript, not under the host's dir.
    // Only a session the host itself drives (a resumed record) keeps the host's own sub log, so a
    // live SDK worker is written and read in the same place.
    const desktopId = record?.sdkSessionId ?? id;
    if ((!record || record.desktopBridge) && this.desktop?.has(desktopId)) return this.desktop.subLog(desktopId, sub);
    if (!this.records.has(id)) return null;
    const key = `${id}/${sub}`;
    let log = this.logs.get(key);
    if (!log) { log = EventLog.open({ dir: path.join(this.opts.dir, "sessions", id, sub), now: this.now }); this.logs.set(key, log); }
    return log;
  }

  /** The wire's blob operation is scoped to one session, including its workers and editing draft. */
  blob(id: string, blob: string): string | null {
    const data = this.log(id).blob(blob);
    if (data !== null) return data;
    for (const [key, log] of this.logs) {
      if (!key.startsWith(`${id}/sub-`)) continue;
      const workerData = log.blob(blob);
      if (workerData !== null) return workerData;
    }
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    return this.desktop?.workerBlob(desktopId, blob) ?? this.sendQueue.editingBlob(id, blob);
  }

  recentSources(): { path: string; lastUsed: number; model: string }[] {
    return Array.from(this.records.values()).map((r) => ({ path: r.cwd, lastUsed: r.updatedAt, model: r.model }));
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify([...this.records.values(), ...this.skippedRecords.values()], null, 1));
  }

  private saveListState(): void {
    writeFileAtomic(this.listFile, JSON.stringify({ attention: Object.fromEntries(this.attention), archived: [...this.archived], readAt: Object.fromEntries(this.readAt) } satisfies ListState));
  }

  /** Set/clear a session's attention, persisting only when it actually changed. */
  private setAttention(id: string, next: Attention | null): void {
    const current = this.attention.get(id) ?? null;
    if (current?.reason === next?.reason && current?.at === next?.at) return;
    if (next) this.attention.set(id, next); else this.attention.delete(id);
    this.saveListState();
  }

  private taskPlans = new Map<string, { log: EventLog; cursor: number; tracker: TaskPlan; activity: BackgroundActivity }>();

  /** Replay only new durable events; a replaced epoch starts from its own list, not a previous session. */
  private taskState(id: string): { log: EventLog; cursor: number; tracker: TaskPlan; activity: BackgroundActivity } {
    let state = this.taskPlans.get(id);
    if (this.shuttingDown && state) return state;
    const log = this.log(id);
    if (!state || state.log !== log) {
      state = { log, cursor: 0, tracker: new TaskPlan(), activity: new BackgroundActivity() };
      this.taskPlans.set(id, state);
    }
    const load = (text: import("./protocol.ts").Text): string => {
      if (typeof text === "string") return text;
      const value = log.blob(text.blob);
      if (value === null) throw new Error("Task input blob is missing");
      return value;
    };
    while (state.cursor < log.lastSeq) {
      const page = log.readAfter(state.cursor);
      for (const event of page.events) { state.tracker.accept(event, load); state.activity.accept(event, load); }
      state.cursor = page.events.at(-1)?.seq ?? log.lastSeq;
      if (!page.more) break;
    }
    return state;
  }

  private invalidateActivity(id: string): void {
    const activity = this.taskState(id).activity;
    if (!activity.active.length && !activity.known) return;
    activity.invalidate();
    this.append(id, { kind: "background", tasks: activity.history, known: false }, false);
  }

  /** `touch` false: the host noticing a session is no longer live is not the session being used (a restart moved every old one to "now"). */
  private append(id: string, body: EventBody, touch = true): SessionEvent {
    const previous = this.taskPlans.get(id);
    const beforePlan = (previous?.tracker.version ?? 0) + (previous?.activity.version ?? 0);
    const event = this.log(id).append(body);
    const r = this.records.get(id);
    const taskEvent = body.kind === "assistant" || body.kind === "tool_result" || body.kind === "user" || body.kind === "subagent" || body.kind === "background";
    const current = r && !r.desktopBridge && taskEvent ? this.taskState(id) : null;
    const planChanged = current && current.tracker.version + current.activity.version !== beforePlan;
    if (r && touch) r.updatedAt = this.now();
    this.opts.onEvent(id, event);
    if (planChanged) this.opts.onSessions();
    return event;
  }

  private setState(r: SessionRecord, state: SessionState, detail?: string, touch = true): void {
    if (r.state === state && !detail) return;
    const from = r.state;
    r.state = state;
    // A bridged session's turn can end on a question the person must answer; that outranks "finished".
    const question = r.desktopBridge ? this.questionAttention(r.id, from, state) : null;
    this.setAttention(r.id, question ?? nextAttention(this.attention.get(r.id) ?? null, from, state, this.now()));
    this.append(r.id, { kind: "state", state, ...(detail ? { detail } : {}) }, touch);
    this.save();
    this.opts.onSessions();
    if (!BUSY.has(state) && this.sendQueue.items(r.id).length) setImmediate(() => void this.drainQueue(r.id));
  }

  // ---- the queue: messages a phone left for when the turn ends (queue.ts) ---------------------

  /** Queue a message; a session that is not busy takes it at once. An id still being sent answers
   * with that send, so its failure reaches the phone rather than an "it is queued". */
  enqueue(id: string, clientMsgId: string, text: string, attachments: Attachment[] = []): Promise<void> | undefined {
    if (!this.has(id)) throw new Error("no such session");
    if (!/^[\w-]{1,100}$/.test(clientMsgId)) throw new Error("Invalid message id.");
    if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("Nothing to queue.");
    if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_COUNT) throw new Error(`At most ${ATTACHMENT_COUNT} attachments.`);
    // The bytes are copied out of the session's blobs now: a desktop rebase deletes those.
    const files = attachments.map(a => {
      const data = a && typeof a.blob === "string" ? this.blob(id, a.blob) : null;
      if (!data || typeof a.name !== "string" || typeof a.mediaType !== "string") throw new Error("Attachment missing or too large (8 MB limit).");
      return { name: a.name, mediaType: a.mediaType, data };
    });
    // An id already sent, by the app or from here, is not queued again: whoever takes it from the
    // queue would run it twice (a phone that lost the answer queues it again).
    const key = `send:${id}:${clientMsgId}`;
    const receipt = this.receipts.status(key);
    if (receipt !== null) {
      if (this.receipts.conflict(key, sendFingerprint(text, attachments))) throw new Error(SAME_ID_OTHER_CONTENT);
      if (receipt === "completed") return;
      const riding = this.sending.get(key) ?? this.bridgeSends.get(`${id}/${clientMsgId}`);
      if (!riding) throw new OutcomeUnknownError();
      return Promise.resolve(riding).then(() => {});
    }
    if (this.seen(id, clientMsgId)) return;
    if (!this.sendQueue.add(id, { id: clientMsgId, text, attachments: files }, this.now(), this.records.get(id)?.sdkSessionId ?? id)) return;
    this.watchQueueRegistry();
    this.opts.onSessions();
    void this.drainQueue(id);
  }

  /** Take text and upload-shaped attachments back to the composer's editing draft. */
  removeQueued(id: string, itemId: string): { text: string; attachments: Attachment[] } | null {
    const item = this.sendQueue.items(id).find(item => item.id === itemId);
    if (!item) return null;
    if (item.claimedBy) throw new Error(MOD_CLAIMED);
    this.withdrawMod(id, itemId);
    const attachments = this.restoreQueuedAttachments(id, item);
    this.sendQueue.remove(id, itemId, attachments);
    this.opts.onSessions();
    return { text: item.text, attachments };
  }

  private restoreQueuedAttachments(id: string, item: QueueItem): Attachment[] {
    return item.attachments.map(a => {
      const data = this.sendQueue.data(a);
      if (data === null) throw new Error("Attachment missing.");
      return { blob: this.log(id).image(data), name: a.name, mediaType: a.mediaType };
    });
  }

  /** Send one queued message now, into the running turn like a steer. */
  async sendQueued(id: string, itemId: string): Promise<string> {
    const item = this.sendQueue.items(id).find(queued => queued.id === itemId);
    if (!item) throw new Error("That message is no longer queued.");
    if (this.sendQueue.items(id).some(queued => queued.claimedBy)) throw new Error(MOD_CLAIMED);
    for (const queued of this.sendQueue.items(id)) this.withdrawMod(id, queued.id);
    this.sendQueue.resume(id);
    return this.inSessionLane(id, async token => {
      if (this.handingOff.has(id) || this.creating.has(this.records.get(id)?.createdBy ?? "")) { this.opts.onSessions(); return id; }
      // Only a completed dispatch, not an edit/removal, can satisfy this send while it waits.
      if (!this.sendQueue.items(id).some(queued => queued.id === itemId) && this.receipts.status(`send:${id}:${itemId}`) === "completed") return id;
      const mayGo = (): void => {
        token.check();
        const now = this.sendQueue.items(id).find(queued => queued.id === itemId);
        if (now !== item) throw new Error("That message is no longer queued.");
        if (this.sendQueue.items(id).some(queued => queued.claimedBy)) throw new Error(MOD_CLAIMED);
        if (this.sendQueue.held(id)) throw new Error("대기열이 멈춰 메시지를 보내지 않았습니다. 대기열을 다시 시작한 후 보내 주세요.");
      };
      mayGo();
      const desktopId = this.records.get(id)?.sdkSessionId ?? id;
      if (this.modEligible(id, desktopId, item)) {
        const offer = this.offerMod(id, desktopId, item);
        const state = offer ? await offer : null;
        // Acceptance hands ownership to the app; its eventual result uses the receipt path.
        if (state && state !== "expired") return id;
        mayGo();
      }
      return this.dispatchQueued(id, item, false, token);
    });
  }

  /** A message on its way into the app (offered to or claimed by the mod) is not shown as queued: it
   * flashed in the queue for a moment before the chat (2026-10-27). A failure shows it again. */
  private queueSummary(id: string): ReturnType<SendQueue["summary"]> {
    const summary = this.sendQueue.summary(id);
    if (!summary.queue) return summary;
    const queue = summary.queue.filter(item => item.error || !this.modOwners.has(item.id) && !this.sendQueue.items(id).find(q => q.id === item.id)?.claimedBy);
    return queue.length ? { ...summary, queue } : {};
  }

  /** The app owns the writer, independently of where the conversation was created. */
  private appModSession(id: string, desktopId: string): boolean {
    const process = this.desktop?.liveProcess(desktopId);
    return !process?.bridgeSessionId && !this.live.has(id) && !this.handingOff.has(id) &&
      !!(process || this.desktop?.isOpen(desktopId));
  }

  /** An idle app session without Remote Control can receive plain text through its mod. */
  private modEligible(id: string, desktopId: string, item: QueueItem): boolean {
    return this.appModSession(id, desktopId) && !this.appBusy(desktopId) && !item.attachments.length && !item.text.trimStart().startsWith("/");
  }

  resumeQueue(id: string): void {
    if (this.sendQueue.resume(id)) { this.opts.onSessions(); void this.drainQueue(id); }
  }

  /** The phone's Stop: what is queued waits for the person instead of going on its own. */
  holdQueue(id: string): void {
    if (!this.sendQueue.hold(id)) return;
    for (const item of this.sendQueue.items(id)) this.withdrawMod(id, item.id);
    this.opts.onSessions();
  }
  /** The socket send joins synchronously, including /clear's settings snapshot. */
  orderedSend(id: string, clientMsgId: string, text: string, attachments?: Attachment[], behavior?: SendBehavior): Promise<string> {
    return this.inSessionLane(id, token => {
      token.check();
      return this.send(id, clientMsgId, text, attachments, behavior, token);
    }, false);
  }

  private draining = new Set<string>();
  /** Every session with something queued, from the desktop poll: Mac sessions change state without a record. */
  drainQueues(): void {
    for (const id of this.sendQueue.sessions()) void this.drainQueue(id);
  }

  /** A cheap queue-only tick: registry idle wins over a stale Remote Control state cache. */
  pollQueued(): void {
    if (this.shuttingDown) return;
    const ids = this.sendQueue.sessions();
    if (!ids.length) { this.closeQueueWatch(); return; }
    this.watchQueueRegistry();
    for (const id of ids) {
      if (this.sendQueue.held(id) || this.draining.has(id)) continue;
      const r = this.records.get(id);
      if (r && !r.desktopBridge) { void this.drainQueue(id); continue; }
      const process = this.desktop?.liveProcess(r?.sdkSessionId ?? id);
      if (!process || process.status === "idle") void this.drainQueue(id, process?.status === "idle");
    }
  }

  private queueWatch: (() => void) | null = null;
  private queueWatchAttempted = false;
  private queueWatchTimer: ReturnType<typeof setTimeout> | null = null;

  private watchQueueRegistry(): void {
    if (!this.desktop || this.queueWatchAttempted || this.shuttingDown) return;
    this.queueWatchAttempted = true;
    this.queueWatch = this.desktop.watchRegistry(() => {
      if (this.shuttingDown || this.queueWatchTimer) return;
      this.queueWatchTimer = setTimeout(() => { this.queueWatchTimer = null; this.pollQueued(); }, 25);
    }, error => (this.opts.log ?? console.error)(`[queue registry watch] ${String(error)}; one-second polling continues`));
  }

  private closeQueueWatch(): void {
    this.queueWatch?.();
    this.queueWatch = null;
    this.queueWatchAttempted = false;
    if (this.queueWatchTimer) clearTimeout(this.queueWatchTimer);
    this.queueWatchTimer = null;
  }

  private async drainQueue(id: string, registryIdle = false): Promise<void> {
    if (this.shuttingDown || this.draining.has(id)) return;
    const head = this.queueHead(id, registryIdle);
    if (!head) return;
    const waited = this.sessionLanes.has(id);
    this.draining.add(id);
    try {
      await this.inSessionLane(id, token => this.drainHead(id, head, registryIdle && !waited, token), false);
    } catch (error) {
      if (this.shuttingDown) return;
      // Dispatch failures are already on the item; expiry also leaves it visible for review.
      if (error instanceof OutcomeUnknownError && this.sendQueue.items(id).includes(head) && !head.claimedBy) {
        this.sendQueue.fail(id, head.id, error.message);
        this.opts.onSessions();
      } else (this.opts.log ?? console.error)(`[queue drain] ${id}: ${String(error)}`);
    } finally {
      this.draining.delete(id);
      if (head.claimedBy || !this.sendQueue.items(id).includes(head)) void this.drainQueue(id);
    }
  }

  /** Recheck after a lane wait, without reserving a busy session on the cheap polling path. */
  private queueHead(id: string, registryIdle: boolean): QueueItem | undefined {
    if (this.handingOff.has(id) || this.closing.has(id) || this.creating.has(this.records.get(id)?.createdBy ?? "") || this.sendQueue.held(id)) return;
    const head = this.sendQueue.items(id)[0];
    if (!head || head.claimedBy) return;
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    const process = this.desktop?.liveProcess(desktopId);
    if (this.appModSession(id, desktopId) && this.appBusy(desktopId)) {
      if (this.sendQueue.wait(id, head.id, DESKTOP_BUSY)) this.opts.onSessions();
      return;
    }
    // Registry idle can precede the accepted bridge turn actually starting.
    const sent = process?.bridgeSessionId ? this.bridgeRunning.get(process.bridgeSessionId) : undefined;
    if (sent !== undefined && this.now() - sent < 9000) return;
    if (!registryIdle) {
      const summary = this.has(id) ? this.summaryOf(id) : undefined;
      if (!summary || BUSY.has(summary.state)) return;
    }
    const awaiting = this.sendQueue.awaiting(id);
    const record = this.records.get(id);
    const appIdle = !!record && !record.desktopBridge && this.canTailHandoff(record) && !this.appBusy(desktopId);
    if (awaiting && !this.sendQueue.settle(id, this.eventsAfter(id, awaiting.seq), this.now(), appIdle)) return;
    return head;
  }

  private async drainHead(id: string, head: QueueItem, registryIdle: boolean, token: LaneToken): Promise<void> {
    token.check();
    if (this.queueHead(id, registryIdle) !== head) return;
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    if (this.modEligible(id, desktopId, head)) {
      const offer = this.offerMod(id, desktopId, head);
      const state = offer ? await offer : null;
      if (state && state !== "expired") return;
      token.check();
      if (this.sendQueue.items(id)[0] !== head || this.sendQueue.held(id)) return;
    }
    await this.dispatchQueued(id, head, true, token);
  }

  private eventsAfter(id: string, seq: number): SessionEvent[] {
    const out: SessionEvent[] = [];
    try {
      const log = this.log(id);
      for (let after = seq; after < log.lastSeq;) {
        const page = log.readAfter(after);
        out.push(...page.events);
        if (!page.more || !page.events.length) break;
        after = page.events[page.events.length - 1]!.seq;
      }
    } catch { /* a session with no log yet has nothing after */ }
    return out;
  }

  private async dispatchQueued(id: string, item: QueueItem, fromQueue: boolean, token?: LaneToken): Promise<string> {
    const attachments: Attachment[] = [];
    for (const a of item.attachments) {
      const data = this.sendQueue.data(a);
      if (!data) { this.sendQueue.fail(id, item.id, "Attachment missing."); this.opts.onSessions(); throw new Error("Attachment missing."); }
      attachments.push({ blob: this.log(id).image(data), name: a.name, mediaType: a.mediaType });
    }
    let before = 0;
    try { before = this.log(id).lastSeq; } catch { /* the send below creates it */ }
    try {
      token?.check();
      const sent = await this.deliver(id, item.id, item.text, attachments, "steer", true, token);
      this.sendQueue.remove(id, item.id);
      // Only a message sent from here waits for its own turn; one sent now rides the running turn.
      if (fromQueue) this.sendQueue.sent(id, before, this.now());
      this.opts.onSessions();
      return sent;
    } catch (error) {
      if (error instanceof DesktopBusyError) this.sendQueue.wait(id, item.id, DESKTOP_BUSY);
      else if (error instanceof DesktopBlockedError) this.sendQueue.wait(id, item.id, DESKTOP_WAITING);
      else this.sendQueue.fail(id, item.id, error instanceof Error ? error.message : String(error));
      this.opts.onSessions();
      throw error;
    }
  }

  private offerMod(id: string, sessionId: string, item: QueueItem): Promise<"claimed" | "withdrawn" | "expired"> | null {
    if (this.modOwners.has(item.id)) return null;
    this.modOwners.set(item.id, id);
    const offered = this.modInbox.offer({ sessionId, itemId: item.id, text: item.text, offeredAt: this.now() }, this.opts.modOfferMs ?? 6000);
    if (!offered) { this.modOwners.delete(item.id); return null; }
    return offered.then(state => { if (state !== "claimed") this.modOwners.delete(item.id); return state; });
  }

  private withdrawMod(id: string, itemId: string): void {
    if (this.modOwners.get(itemId) === id) this.modInbox.withdraw(itemId);
  }

  private rememberModEcho(id: string, offer: ModOffer): void {
    while (this.modEchoes.size >= Sessions.ECHO_CAP) this.modEchoes.delete(this.modEchoes.keys().next().value!);
    this.modEchoes.set(offer.itemId, { id, text: offer.text, expires: this.now() + 60_000 });
  }

  /**
   * A recordless app session is a snapshot rebuilt from the app's transcript, so the phone's id for
   * a message the mod typed in goes on the matching user line here: by text the first time, then by
   * that line's uuid on every later rebuild. Without it the phone kept its own copy "sending" beside
   * the app's for ten minutes (2026-10-28).
   */
  private appUserId(id: string, uuid: string, text: string): string | undefined {
    const known = this.appUserIds.get(uuid);
    if (known || this.records.has(id)) return known;
    const itemId = this.takeModEcho(id, text);
    if (!itemId) return undefined;
    while (this.appUserIds.size >= Sessions.ECHO_CAP) this.appUserIds.delete(this.appUserIds.keys().next().value!);
    this.appUserIds.set(uuid, itemId);
    return itemId;
  }
  private appUserIds = new Map<string, string>();

  private takeModEcho(id: string, text: string): string | undefined {
    for (const [itemId, echo] of this.modEchoes) {
      if (echo.expires < this.now()) { this.modEchoes.delete(itemId); continue; }
      if (echo.id === id && echo.text === text) { this.modEchoes.delete(itemId); return itemId; }
    }
    return undefined;
  }

  private finishMod(offer: ModOffer, outcome: ModOutcome): void {
    const id = this.modOwners.get(offer.itemId);
    if (!id) throw new Error("Missing mod offer owner");
    if (outcome === "failed") { this.modEchoes.delete(offer.itemId); this.sendQueue.failMod(id, offer.itemId, MOD_UNKNOWN); }
    else {
      const key = `send:${id}:${offer.itemId}`;
      if (this.receipts.status(key) === null) this.receipts.begin(key, id, sendFingerprint(offer.text, []));
      this.personMessage(id);
      // A recordless session is a rebuilt transcript snapshot, not a host-owned event log.
      // Its user event must come from the app: appending here would duplicate it until rebuild.
      if (this.records.has(id) && !this.seen(id, offer.itemId)) {
        this.append(id, { kind: "user", text: offer.text, clientMsgId: offer.itemId, images: [] });
        this.rememberClientMsgId(id, offer.itemId);
      }
      if (!this.records.has(id)) {
        // The echo stays: the snapshot rebuild puts the phone's id on the app's user line with it.
        this.watchDesktop(id);
        this.tailDesktop(id);
      }
      this.receipts.complete(key, id);
      // No "awaiting" settle: an app-run turn leaves no result in this log (the tail does not write
      // one), so the next message stuck in the queue until a manual send (2026-10-27). The app's
      // registry status (appBusy) already holds the next message while this turn runs.
      this.sendQueue.remove(id, offer.itemId);
    }
    this.modOwners.delete(offer.itemId);
    this.opts.onSessions();
    // A message that came in behind this one waited in the queue for the next poll.
    if (outcome !== "failed" && this.sendQueue.items(id).length) setImmediate(() => void this.drainQueue(id));
  }

  // ---- what the phone asks for --------------------------------------------------------------

  /** Idempotent on clientMsgId: a phone that resends after a dropped ack gets the same session.
   * A resend that finds a pending receipt left from before a host restart throws
   * OutcomeUnknownError instead of running again: the first attempt may or may not have run. */
  create(req: { clientMsgId: string; cwd: string; model: string; effort: Effort | null; text: string; permissionMode?: PermissionMode; isolation?: Isolation; baseBranch?: string }, title?: string): Promise<string> {
    const key = `create:${req.clientMsgId}`;
    const status = this.receipts.status(key);
    if (status !== null && this.receipts.conflict(key, createFingerprint(req))) return Promise.reject(new Error(SAME_ID_OTHER_CONTENT));
    for (const r of this.records.values()) if (r.createdBy === req.clientMsgId) return Promise.resolve(r.id);
    if (status === "completed") {
      const session = this.receipts.sessionOf(key);
      if (session && this.records.has(session)) return Promise.resolve(session);
      if (session) return Promise.resolve(session);
    }
    if (status === "pending") {
      // A resend can arrive while the first create is still checking the folder; both get the one session.
      const riding = this.creating.get(req.clientMsgId);
      if (riding) return riding;
      throw new OutcomeUnknownError();
    }
    this.receipts.begin(key, "", createFingerprint(req));
    // A resend can arrive while the first create is still checking the folder; both get the one session.
    let pending = this.creating.get(req.clientMsgId);
    if (!pending) {
      pending = this.createNew(req, title).then(
        id => { this.receipts.complete(key, id); return id; },
        (error: unknown) => { this.receipts.abandon(key); throw error; },
      ).finally(() => this.creating.delete(req.clientMsgId));
      this.creating.set(req.clientMsgId, pending);
    }
    return pending;
  }

  /** Match both the bridge organization and the app's current account, never guess between identities. */
  private environmentFor(cwd: string): string | null {
    if (!this.opts.handoff || !this.desktop || (!this.opts.desktopSidebar && !this.opts.environmentRoot)) return null;
    const root = this.opts.environmentRoot ?? this.opts.desktopSidebar?.root ?? path.join(os.homedir(), "Library", "Application Support", "Claude");
    try {
      const login = this.bridge.identity();
      const config = object(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")));
      const account = config?.lastKnownAccountUuid;
      if (typeof account !== "string" || !account || login.accountUuid && login.accountUuid !== account) return null;
      const state = object(JSON.parse(fs.readFileSync(path.join(root, "remote-control-state.json"), "utf8")));
      const identities = object(state?.identities);
      const matching = Object.keys(identities ?? {}).filter(key => key.startsWith(`${login.organizationUuid}:`));
      if (!login.accountUuid && matching.length !== 1) return null;
      const identity = object(identities?.[`${login.organizationUuid}:${account}`]);
      if (identity?.serve !== "on") return null;
      const folder = object(object(identity.folders)?.[cwd]);
      return typeof folder?.environmentId === "string" && /^env_[\w-]+$/.test(folder.environmentId) ? folder.environmentId : null;
    } catch { return null; } // Missing, unreadable or ambiguous app/login state cannot select an environment.
  }

  private async createNew(req: { clientMsgId: string; cwd: string; model: string; effort: Effort | null; text: string; permissionMode?: PermissionMode; isolation?: Isolation; baseBranch?: string }, title?: string): Promise<string> {
    const mode = req.permissionMode ?? "auto";
    if (!PERMISSION_MODES.includes(mode)) throw new Error("invalid permission mode");
    const isolation = req.isolation ?? "local";
    if (isolation !== "local" && isolation !== "worktree") throw new Error("invalid isolation");
    // Read first, so a folder macOS guards says so now rather than holding the session at "starting".
    await macConsent(path.resolve(req.cwd), () => readableFolder(path.resolve(req.cwd)));
    // A worktree session runs in a fresh branch under the repo's parent; the picked folder itself is
    // never modified. The host validates everything (worktree.ts), refusing a folder that is not a repo.
    const cwd = isolation === "worktree"
      ? (await createWorktree({ cwd: path.resolve(req.cwd), text: req.text, ...(req.baseBranch ? { baseBranch: req.baseBranch } : {}), now: this.now })).dir
      : path.resolve(req.cwd);
    if (!(await isDirectory(cwd))) throw new Error(`not a folder: ${cwd}`);
    const now = this.now();
    const r: SessionRecord = { id: randomUUID(), sdkSessionId: null, cwd, model: req.model, effort: req.effort, permissionMode: mode, title: title?.trim() || oneLine(req.text, 80), createdAt: now, updatedAt: now, state: "starting", createdBy: req.clientMsgId, contextWindow: null, desktopHandoff: "pending" };
    this.records.set(r.id, r);
    this.save();
    this.append(r.id, { kind: "state", state: "starting" });
    const environment = isolation === "local" ? this.environmentFor(cwd) : null;
    if (environment && await this.createInEnvironment(r, environment, req.text, req.clientMsgId, mode)) return r.id;
    if (this.opts.handoff) this.append(r.id, { kind: "notice", code: "desktop_handoff" });
    if (req.text.trim()) await this.send(r.id, req.clientMsgId, req.text);
    else this.setState(r, "idle");
    this.opts.onSessions();
    return r.id;
  }

  /** A durable held draft precedes the POST, so even a crash cannot trigger a second writer. */
  private async createInEnvironment(r: SessionRecord, environment: string, text: string, clientMsgId: string, mode: PermissionMode): Promise<boolean> {
    const failure = ENVIRONMENT_UNKNOWN;
    if (text.trim()) {
      this.sendQueue.add(r.id, { id: clientMsgId, text, attachments: [] }, this.now());
      // Held under the starting line while this runs; a host restart turns it into the failure (constructor).
      this.sendQueue.fail(r.id, clientMsgId, ENVIRONMENT_STARTING);
    }
    r.desktopHandoff = "excluded";
    r.environmentCreateUnknown = true;
    this.save();
    let bridgeId: string;
    try { bridgeId = await this.bridge.createEnvironmentSession(environment, r.title); }
    catch (error) {
      if (bridgeCreateNotCreated(error)) {
        delete r.environmentCreateUnknown;
        r.desktopHandoff = "pending";
        if (text.trim()) this.sendQueue.remove(r.id, clientMsgId);
        this.save();
        return false;
      }
      // ARCHITECTURE.md:1760: a lost POST response cannot prove the server did nothing.
      this.append(r.id, { kind: "result", ok: false, error: failure, ms: 0, turns: 0 });
      this.setState(r, "error", failure);
      return true;
    }
    delete r.environmentCreateUnknown;
    r.environmentBridgeId = bridgeId;
    r.desktopBridge = true;
    this.save();
    const deadline = performance.now() + (this.opts.environmentWaitMs ?? 30_000);
    try {
      for (;;) {
        try {
          const session = await this.bridge.session(bridgeId);
          this.bridgeStates.set(bridgeId, { at: this.now(), state: session.worker_status === "requires_action" ? "waiting" : session.worker_status });
          break;
        } catch (error) {
          if (performance.now() >= deadline || this.shuttingDown) throw error;
          await delay(Math.min(this.opts.environmentPollMs ?? 1000, Math.max(0, deadline - performance.now())));
        }
      }
      this.ensureBridge(r.id, bridgeId);
      // Unsupported or unanswered controls leave the app's defaults; no unverified wire fields.
      // Start all writes before the deadline: a late reply must not launch another control after send.
      const model = modelArg(r.model, r.effort);
      const controls = [
        this.bridge.control(bridgeId, randomUUID(), { subtype: "set_model", model: model.model }),
        this.bridge.control(bridgeId, randomUUID(), { subtype: "set_permission_mode", mode }),
        ...(isClaudeModel(r.model) ? [this.bridge.control(bridgeId, randomUUID(), { subtype: "apply_flag_settings", settings: { effortLevel: r.effort } })] : []),
      ];
      for (const control of controls) void control.catch(error => (this.opts.log ?? console.error)(`[environment settings] ${error instanceof Error ? error.message : String(error)}`));
      // The app starts these sessions in acceptEdits. A stricter mode the person picked must be
      // confirmed before the first message, or that message could edit files they meant to review.
      if (mode === "plan" || mode === "default") {
        const applied = await Promise.race([controls[1]!.then(() => true, () => false), delay(this.opts.environmentModeMs ?? 10_000).then(() => false)]);
        if (!applied) throw new EnvironmentModeError();
      }
      await Promise.race([Promise.allSettled(controls), delay(2000)]);
      if (text.trim()) {
        const item = this.sendQueue.items(r.id).find(item => item.id === clientMsgId)!;
        await this.dispatchQueued(r.id, item, false);
        this.pollEnvironmentAdoption(r);
      } else this.setState(r, "idle");
    } catch (error) {
      const reason = error instanceof EnvironmentModeError ? ENVIRONMENT_MODE : failure;
      if (text.trim()) this.sendQueue.fail(r.id, clientMsgId, reason);
      this.append(r.id, { kind: "result", ok: false, error: reason, ms: 0, turns: 0 });
      this.setState(r, "error", reason);
    }
    this.opts.onSessions();
    return true;
  }

  /** Idempotent on clientMsgId. Starts (or resumes) the query when none is live.
   * The receipt is written pending before the input reaches the SDK and completed once the SDK
   * has accepted it; a resend of a completed id returns without running again, and a resend that
   * finds a pending receipt from before a host restart throws OutcomeUnknownError.
   * During Desktop handoff, ACK means durable queue ownership; its send receipt starts only at dispatch. */
  send(id: string, clientMsgId: string, text: string, attachments: Attachment[] = [], behavior?: SendBehavior, token?: LaneToken): string | Promise<string> {
    token?.check();
    const key = `send:${id}:${clientMsgId}`;
    if (this.receipts.status(key) !== null) return this.deliver(id, clientMsgId, text, attachments, behavior ?? "steer", false, token);
    const existing = this.sendQueue.items(id).find(item => item.id === clientMsgId);
    if (existing) {
      if (existing.text !== text || existing.attachments.length !== attachments.length) throw new Error(SAME_ID_OTHER_CONTENT);
      return id;
    }
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    const eligible = this.appModSession(id, desktopId);
    if (eligible && !this.handedOff(id) && (behavior === "interrupt" || attachments.length || text.trimStart().startsWith("/"))) throw new DesktopBlockedError();
    if (eligible && this.seen(id, clientMsgId)) return id;
    if (eligible && this.sendQueue.items(id).some(item => item.claimedBy || this.modOwners.get(item.id) === id)) {
      if (this.sendQueue.items(id).some(item => item.id === clientMsgId)) return id;
      if (behavior === "interrupt" || attachments.length || text.trimStart().startsWith("/")) throw new Error(MOD_CLAIMED);
      this.enqueue(id, clientMsgId, text, attachments);
      return id;
    }
    // The phone sends "steer" on every send (composer.tsx); with nothing running here it is a plain send.
    if (eligible && behavior !== "interrupt" && !attachments.length && text.trim() && !text.trimStart().startsWith("/") && !this.appBusy(desktopId)) {
      this.enqueue(id, clientMsgId, text, attachments);
      return id;
    }
    return this.deliver(id, clientMsgId, text, attachments, behavior ?? "steer", false, token);
  }

  private deliver(id: string, clientMsgId: string, text: string, attachments: Attachment[], behavior: SendBehavior, queued = false, token?: LaneToken): string | Promise<string> {
    token?.check();
    if (behavior !== "steer" && behavior !== "interrupt") throw new Error("Invalid send behavior.");
    const key = `send:${id}:${clientMsgId}`;
    const fingerprint = sendFingerprint(text, attachments);
    if (this.receipts.status(key) === "completed") {
      // The id was accepted with other content: a silent ack would tell the phone work ran that
      // never did. (Receipts from before fingerprints keep the idempotent answer.)
      if (this.receipts.conflict(key, fingerprint)) throw new Error(SAME_ID_OTHER_CONTENT);
      return id;
    }
    if (this.receipts.status(key) === "pending") {
      if (this.receipts.conflict(key, fingerprint)) throw new Error(SAME_ID_OTHER_CONTENT);
      const riding = this.sending.get(key) ?? this.bridgeSends.get(`${id}/${clientMsgId}`);
      if (riding) return riding;
      throw new OutcomeUnknownError();
    }
    if (this.seen(id, clientMsgId)) return id;
    if (!queued && this.sendQueue.items(id).some(item => item.id === clientMsgId)) return id;
    // Delegated turns own their own receipts; this wrapper only forwards them.
    if (/^\/(clear|new)\s*$/.test(text) && !attachments.length) {
      const s = this.list().find(s => s.id === id);
      if (!s) throw new Error("no such session");
      // This is a fresh conversation, not an SDK /clear: carry its label separately from the
      // empty prompt so persistence, the first SDK launch and the desktop handoff all retain it.
      // A desktop session's mode is the app's latest, which the summary reads from its transcript;
      // the record still holds the mode it was imported with. After a plain handoff the summary
      // omits the mode, so the user's own choice on the record is what carries over.
      const record = this.records.get(id);
      const permissionMode = (record?.desktopBridge ? s.permissionMode : undefined) ?? record?.confirmedSettings?.permissionMode ?? record?.permissionMode ?? s.permissionMode ?? "default";
      return this.create({ clientMsgId, cwd: s.cwd, model: s.model, effort: s.effort, permissionMode, text: "" }, s.title);
    }
    // The composer's /exit archives the session (phase 2): a flag, not a close — nothing is deleted.
    if (/^\/exit\s*$/.test(text)) { this.setArchived(id, true); return id; }
    if (behavior === "interrupt") return this.interrupt(id).then(() => this.send(id, clientMsgId, text, attachments, "steer", token));
    // A Desktop handoff may finish before its RC transport exists. Acknowledge durable queue
    // ownership, not an in-memory transfer that would later fail despite the phone's ACK.
    if (!queued && this.records.get(id)?.environmentBridgeId && this.creating.has(this.records.get(id)!.createdBy)) {
      this.enqueue(id, clientMsgId, text, attachments);
      return id;
    }
    if (!queued && this.handingOff.has(id) && this.records.get(id)?.desktopHandoff === "opening") {
      this.enqueue(id, clientMsgId, text, attachments);
      return id;
    }
    // The same for an app-held session while the app runs a turn in it: queue it, send it after.
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    if (!queued && this.appModSession(id, desktopId) && this.appBusy(desktopId)) {
      this.enqueue(id, clientMsgId, text, attachments);
      const head = this.sendQueue.items(id)[0];
      if (head && this.sendQueue.wait(id, head.id, DESKTOP_BUSY)) this.opts.onSessions();
      return id;
    }
    this.receipts.begin(key, id, fingerprint);
    try {
      return this.trackReceipt(key, this.sendAccepted(id, clientMsgId, text, attachments, token));
    } catch (error) {
      this.receipts.abandon(key);
      throw error;
    }
  }

  /** Complete the receipt once the SDK accepted the input; abandon it when the attempt never got there. */
  private trackReceipt(key: string, work: string | Promise<string>): string | Promise<string> {
    if (typeof work === "string") { this.receipts.complete(key); return work; }
    const tracked = work.then(
      session => { this.receipts.complete(key, session); return session; },
      (error: unknown) => { if (!(error instanceof OutcomeUnknownError)) this.receipts.abandon(key); throw error; },
    );
    this.sending.set(key, tracked);
    void tracked.finally(() => { if (this.sending.get(key) === tracked) this.sending.delete(key); }).catch(() => {});
    return tracked;
  }

  private sendAccepted(id: string, clientMsgId: string, text: string, attachments: Attachment[], token?: LaneToken): string | Promise<string> {
    // Stop closes this query's inbox before awaiting the SDK. Reject before recording the
    // user/seen id or converting attachments, so a retry can enter the next query exactly once.
    if (this.live.get(id)?.interrupted) throw new Error("Session interrupt is still in progress. Try again.");
    const existing = this.records.get(id);
    if (existing?.environmentCreateUnknown) throw new OutcomeUnknownError();
    if (existing?.environmentBridgeId) return this.sendBridge(id, clientMsgId, text, attachments, existing.environmentBridgeId, token).then(sent => {
      if (!existing.sdkSessionId) this.pollEnvironmentAdoption(existing);
      return sent;
    });
    const desktopId = existing?.sdkSessionId ?? id;
    if (this.desktop && !this.live.has(id) && !this.handingOff.has(id) && (existing?.sdkSessionId || this.desktop.has(id))) {
      const process = this.desktop.liveProcess(desktopId);
      if (process?.bridgeSessionId) {
        const key = `${id}/${clientMsgId}`;
        const pending = this.bridgeSends.get(key);
        if (pending) return pending;
        const sending = this.sendBridge(id, clientMsgId, text, attachments, process.bridgeSessionId, token).finally(() => this.bridgeSends.delete(key));
        this.bridgeSends.set(key, sending);
        return sending;
      }
      if (this.appModSession(id, desktopId)) {
        // Preserve the legacy handed-off fallback, but never adopt an app-created writer.
        if (!this.handedOff(id)) throw new DesktopBlockedError();
        if (this.appBusy(desktopId)) throw new DesktopBusyError();
      }
      if (existing?.desktopBridge) { this.closeBridge(id); existing.desktopBridge = false; this.save(); }
    }
    const r = this.records.get(id) ?? this.continueDesktop(id, clientMsgId);
    id = r.id;
    if (this.closing.has(id)) throw new DesktopBusyError();
    if (this.canTailHandoff(r)) this.tailDesktop(id);
    if (this.seen(id, clientMsgId)) return id;
    this.personMessage(id);
    const converted = attachmentContent(r.cwd, text, attachments, blob => this.blob(id, blob), data => this.log(id).image(data));
    this.opts.permissions.denySession(id, "superseded by a new message from the user");
    this.append(id, { kind: "user", text, clientMsgId, images: converted.images });
    this.rememberClientMsgId(id, clientMsgId);
    let live = this.live.get(id);
    const handoff = this.handingOff.get(id);
    if (!live && !handoff) live = this.start(r);
    // A message sent while a turn runs is queued by the CLI and starts no turn of its own yet.
    if (r.state !== "running" && r.state !== "waiting") {
      if (live) live.turnStart = this.now();
      const settings = this.effectiveSettings(r);
      this.append(id, { kind: "turn", model: settings.model, effort: settings.effort });
      this.setState(r, "running");
    }
    const message: SdkUserMessage = { type: "user", uuid: uuidFrom(clientMsgId), message: { role: "user", content: converted.content }, parent_tool_use_id: null, session_id: r.sdkSessionId ?? "", origin: { kind: "human" } };
    if (handoff) handoff.messages.push(message);
    else if (live) { live.pendingMessages.push(message); live.input.push(message); }
    this.sendQueue.releaseEditing(id);
    return id;
  }

  private async sendBridge(id: string, clientMsgId: string, text: string, attachments: Attachment[], bridgeId: string, token?: LaneToken): Promise<string> {
    if (attachments.some(a => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a?.mediaType))) {
      throw new Error("Only photos can be attached to Claude app sessions for now.");
    }
    const r = this.records.get(id) ?? this.continueDesktop(id, clientMsgId, true);
    // Rebase deletes this log's blobs too: validate and retain the bytes before it can run.
    const converted = attachmentContent(r.cwd, text, attachments, blob => this.blob(id, blob), data => this.log(id).image(data));
    if (Array.isArray(converted.content)) {
      const blocks = converted.content;
      const images = blocks.filter(block => block.type === "image");
      if (images.reduce((size, block) => size + block.source.data.length, 0) > ATTACHMENT_COUNT * ATTACHMENT_CAP) {
        throw new Error("Photo payload is too large.");
      }
      converted.content = [...images, ...blocks.filter(block => block.type === "text")];
    }
    if (!r.desktopBridge) this.rebaseDesktop(r);
    if (this.seen(id, clientMsgId)) return id;
    this.personMessage(id);
    // Re-store in the current epoch; the local event must never point at deleted upload blobs.
    if (Array.isArray(converted.content)) {
      let index = 0;
      for (const block of converted.content) {
        if (block.type === "image") converted.images[index++]!.blob = this.log(id).image(block.source.data);
      }
    }
    const prior = this.bridges.get(id);
    if (prior?.bridgeId === bridgeId && prior.permissions.size) this.supersedeBridge(id, prior);
    // The stream only carries permission prompts; sending does not depend on it.
    this.ensureBridge(id, bridgeId);
    // The API takes only a UUID; phones send short random ids. Derived, not random, so a retry of
    // the same message is the same event; the transcript echoes it under this uuid.
    const uuid = UUID_RE.test(clientMsgId) ? clientMsgId : uuidFrom(clientMsgId);
    while (this.bridgeEchoes.size >= Sessions.ECHO_CAP) this.bridgeEchoes.delete(this.bridgeEchoes.values().next().value!);
    this.bridgeEchoes.add(uuid);
    token?.check();
    try { await this.bridge.send(bridgeId, uuid, converted.content); }
    catch (error) {
      this.noteBridge(bridgeId, error, "bridge send");
      if (bridgeWriteUnknown(error)) throw new OutcomeUnknownError();
      throw error;
    }
    this.noteBridge(bridgeId, null);
    this.bridgeRunning.set(bridgeId, this.now());
    // The durable user event also deduplicates the desktop transcript's echo by uuid.
    this.append(id, { kind: "user", text, clientMsgId, images: converted.images });
    this.rememberClientMsgId(id, clientMsgId);
    // A new turn event and running event reset the phone's clock even if the previous record
    // was still running. Never synthesize idle between them: that also flashes a finished turn.
    this.append(id, { kind: "turn", model: r.model, effort: r.effort });
    if (r.state === "running") this.append(id, { kind: "state", state: "running" });
    else this.setState(r, "running");
    this.opts.onSessions();
    this.sendQueue.releaseEditing(id);
    return id;
  }

  /**
   * A record the host once drove (resume) becomes a Remote Control one: its log stops where the
   * host stopped, so it is rebuilt from the transcript instead of tailing from "now" and
   * skipping everything the desktop app said in between. The new epoch makes phones refetch.
   */
  private rebaseDesktop(r: SessionRecord): void {
    if (!this.desktop) return;
    const dir = path.join(this.opts.dir, "sessions", r.id);
    this.logs.get(r.id)?.close();
    this.logs.delete(r.id);
    // The log is rebuilt from the transcript: ids the old log held may be gone, so the
    // duplicate index must not claim them as seen or a resend would be dropped unsent.
    this.seenIds.delete(r.id);
    fs.rmSync(dir, { recursive: true, force: true });
    this.logs.set(r.id, this.desktop.importInto(r.sdkSessionId ?? r.id, dir, this.now));
    for (const outcome of this.settings.replay(r.id)) this.append(r.id, { kind: "settings", ...outcome });
    r.desktopBridge = true;
    // A control acknowledged by the SDK cannot confirm the replacement desktop worker's mode.
    if (r.confirmedSettings) delete r.confirmedSettings.permissionMode;
    r.contextWindow = null;
    r.transcriptOffset = this.desktop.transcriptSize(r.sdkSessionId ?? r.id);
    this.save();
    this.opts.onSessions();
  }

  /**
   * A rename on the Mac lands in the transcript as a custom-title line, and a conversation moved to
   * another folder updates the app's registry rather than the transcript's first line. The session
   * list, pushes and relative paths read the record, so refresh both when they change. Read-only:
   * never writes the transcript, and a failed read only logs.
   */
  private refreshBridgeMeta(r: SessionRecord): void {
    if (!this.desktop) return;
    try {
      const transcript = r.sdkSessionId ?? r.id;
      const cwd = this.desktop.liveProcess(transcript)?.cwd;
      if (cwd && cwd !== r.cwd) { r.cwd = cwd; this.save(); this.opts.onSessions(); }
      const size = this.desktop.transcriptSize(transcript);
      if (size === this.bridgeTitleSize.get(r.id)) return;
      this.bridgeTitleSize.set(r.id, size);
      const meta = this.desktop.metadataOf(transcript);
      const transcriptModelAllowed = !r.confirmedSettings?.model && !this.desktopSettings?.appSettingsFor(transcript) && !r.appSettingsGuard;
      if (meta && (meta.title !== r.title || transcriptModelAllowed && meta.model && meta.model !== r.model)) {
        r.title = meta.title;
        if (meta.model && transcriptModelAllowed) {
          if (r.model !== meta.model) r.contextWindow = null;
          r.model = meta.model;
        }
        this.save();
        this.opts.onSessions();
      }
    } catch (error) {
      (this.opts.log ?? console.error)(`[bridge meta] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private ensureBridge(id: string, bridgeId: string) {
    const previous = this.bridges.get(id);
    // A failed stream is retried on the next poll or send rather than blocking the session for good.
    if (previous?.bridgeId === bridgeId && !previous.failed) { this.watchDesktop(id); return previous; }
    this.closeBridge(id, previous?.bridgeId === bridgeId);
    const connection = { bridgeId, abort: new AbortController(), failed: false, permissions: new Map<string, BridgePending>() };
    this.bridges.set(id, connection);
    const replay = (): void => {
      // After every stream (re)connect, re-read approvals already waiting: the stream starts at
      // the newest event, so anything requested before it connected would otherwise never card.
      void this.syncBridgeApprovals(id, bridgeId).catch(error => this.noteBridge(bridgeId, error, "bridge replay"));
    };
    void this.bridge.stream(bridgeId, connection.abort.signal, frame => this.bridgeFrame(id, frame), replay).catch(error => {
      if (!connection.abort.signal.aborted) this.bridgeFailure(id, error);
    });
    replay();
    this.watchDesktop(id);
    return connection;
  }

  private closeBridge(id: string, preserveRunning = false): void {
    this.unwatchDesktop(id);
    const connection = this.bridges.get(id);
    if (!connection) return;
    // A stream reconnect is still the same worker: durable replies may settle its writes later.
    // A replacement/removal cannot confirm the old worker's writes and must release its lane.
    if (!preserveRunning) {
      this.bridgeRunning.delete(connection.bridgeId);
      this.bridge.closeControls(connection.bridgeId);
    }
    connection.abort.abort();
    this.opts.permissions.expireSession(id, "aborted");
    this.bridges.delete(id);
    // With nothing pending, a permission attention would otherwise stick: markSeen skips it and
    // decide on an expired record returns false, so clear it the way answering does.
    this.clearPermissionAttention(id);
  }

  private bridgeFailure(id: string, error: unknown): void {
    const connection = this.bridges.get(id);
    if (connection) { connection.failed = true; connection.abort.abort(); }
    this.opts.permissions.expireSession(id, "aborted");
    this.clearPermissionAttention(id);
    // Logged, not shown: a dropped permission stream reconnects on the next poll and says nothing
    // new to the user — unless the login is the cause, which noteBridge tells phones once.
    this.noteBridge(connection?.bridgeId ?? id, error, "remote control stream");
  }

  private bridgeFrame(id: string, frame: BridgeFrame): void {
    if (frame.event !== "client_event") return;
    const payload = object(frame.data.payload);
    const connection = this.bridges.get(id);
    if (!payload || !connection) return;
    // Worker setting replies never settle approval cards; client echoes never apply settings.
    if (this.bridge.controlResponse(connection.bridgeId, frame.data.source, payload)) return;
    // Responses from another client close a pending card during replay or live delivery.
    if (payload.type === "control_response") {
      const response = object(payload.response);
      if (typeof response?.request_id !== "string") return;
      const pending = connection.permissions.get(response.request_id);
      if (pending) this.opts.permissions.expire(pending.id, "cancelled");
      connection.permissions.delete(response.request_id);
      this.rememberAnsweredBridge(id, response.request_id);
      return;
    }
    // Only the server's worker channel may ask for authorization or withdraw a request.
    if (frame.data.source !== "worker" || typeof payload.request_id !== "string") return;
    const requestId = payload.request_id;
    if (payload.type === "control_cancel_request") {
      const pending = connection.permissions.get(requestId);
      if (pending) this.opts.permissions.expire(pending.id, "cancelled");
      connection.permissions.delete(requestId);
      this.rememberAnsweredBridge(id, requestId);
      return;
    }
    const request = object(payload.request);
    const input = object(request?.input);
    if (payload.type !== "control_request" || request?.subtype !== "can_use_tool" || typeof request.tool_name !== "string" || !input || typeof request.tool_use_id !== "string" || connection.permissions.has(requestId)) return;
    const r = this.records.get(id);
    if (!r) return;
    this.openBridgePermission(id, connection, r, { requestId, tool: request.tool_name, input, toolUseId: request.tool_use_id,
      permissionSuggestions: request.permission_suggestions, suppressAlwaysAllowRule: permissionSuppression(request) });
  }

  /** A permission prompt from Remote Control, live or replayed: one record, one card, one decision. */
  private openBridgePermission(id: string, connection: { bridgeId: string; abort: AbortController; failed: boolean; permissions: Map<string, BridgePending> }, r: SessionRecord, req: BridgePermissionRequest): void {
    if (connection.permissions.has(req.requestId) || this.wasAnsweredBridge(id, req.requestId)) return;
    // The permission stream can beat the transcript watch/poll. Publish the assistant's
    // completed blocks first, or its question reaches the phone without its preamble.
    this.tailBridge(r);
    const { record, decision } = this.opts.permissions.request({ session: id, tool: req.tool, title: "", summary: summarize(req.tool, req.input, r.cwd), input: req.input }, connection.abort.signal);
    const rules = sessionPermissionRules(req.tool, req.permissionSuggestions, req.suppressAlwaysAllowRule);
    this.permissionRules.set(record.id, rules);
    connection.permissions.set(req.requestId, { id: record.id, input: req.input, toolUseId: req.toolUseId, rules });
    // Remote Control's can_use_tool carries the same input the host path gets, so a question or a
    // plan is carded as one here too (a JSON tool approval cannot answer either, issue #82).
    const card = bridgeRequest(req.tool, req.input);
    this.append(id, { kind: "permission", id: record.id, tool: record.tool, title: "", summary: record.summary, input: permissionDetail(record.tool, req.input, r.cwd), canAlways: rules.length > 0, ...(rules.length ? { alwaysAllow: { scope: "session" as const, summary: rules.flatMap(update => update.rules.map(rule => `${rule.toolName}(${rule.ruleContent})`)).join("\n") } } : {}), requestKind: card.requestKind, ...(card.questions ? { questions: card.questions } : {}) });
    this.setState(r, "waiting");
    void decision.then(answer => {
      // Shutdown expires every open request after its logs are closed; there is nobody left to read it.
      if (this.shuttingDown) return;
      this.append(id, { kind: "permission_decided", id: record.id, decision: answer.decision, ...(answer.decision === "allow_always" ? { ruleStatus: "sent" as const } : {}), ...(answer.reason ? { reason: answer.reason } : {}) });
      this.permissionRules.delete(record.id);
      if (answer.decision === "expired") connection.permissions.delete(req.requestId);
      this.clearPermissionAttention(id);
      this.opts.onSessions();
    });
  }

  /** Re-read approvals already waiting on a Mac session (phone attach and every stream
   * reconnect), so no approval card is missed. Reads the session's events from the start cursor
   * (BridgeClient.events, `sort_order=asc`) instead of the stream's newest-event cursor. */
  async syncBridge(id: string): Promise<void> {
    const bridgeId = this.bridges.get(id)?.bridgeId
      ?? this.desktop?.liveProcess(this.records.get(id)?.sdkSessionId ?? id)?.bridgeSessionId;
    if (!bridgeId) return;
    // A Mac session the host never opened has no record yet: import it (bridge mode) first.
    if (!this.records.has(id)) {
      try { this.log(id); } catch { return; }
    }
    this.ensureBridge(id, bridgeId);
    await this.syncBridgeApprovals(id, bridgeId);
  }

  private async syncBridgeApprovals(id: string, bridgeId: string): Promise<void> {
    const connection = this.bridges.get(id);
    const r = this.records.get(id);
    if (!connection || connection.bridgeId !== bridgeId || !r) return;
    // Cards opened after this read began may belong to a request the snapshot predates, so only
    // cards that already existed are closed on its word.
    const startedAt = this.now();
    let requests;
    try { requests = await this.bridge.requests(bridgeId); }
    catch (error) { this.bridgeFailure(id, error); return; }
    if (requests === null) return;
    if (this.bridges.get(id) !== connection) return;
    const { open, closed } = requests;
    // A card whose request this read saw answered or withdrawn was settled somewhere else — the
    // person used the Claude app. Leaving it pending kept a question on the phone that the app had
    // already closed, and the next replay carded it again (issue #82). A request merely missing from
    // the list proves nothing: the list may not reach it, and closing on that would take a live
    // question away from the phone.
    for (const [requestId, pending] of [...connection.permissions]) {
      if (!closed.has(requestId)) continue;
      const record = this.opts.permissions.get(pending.id);
      if (record?.state === "pending" && record.createdAt >= startedAt) continue;
      connection.permissions.delete(requestId);
      this.rememberAnsweredBridge(id, requestId);
      this.opts.permissions.expire(pending.id, "cancelled"); // its decision handler writes the event
    }
    for (const req of open) this.openBridgePermission(id, connection, r, req);
  }

  /**
   * Remember a bridge requestId as answered, so a replay that still lists it (the server records
   * the control_response after we do, or never records an answer made in the desktop app) skips it
   * instead of reviving an answered card. Bounded to the most recent ANSWERED_CAP entries; a
   * requestId is never reused, so an entry needs no other expiry.
   */
  private rememberAnsweredBridge(id: string, requestId: string): void {
    this.answeredBridge.set(`${id}/${requestId}`, this.now());
    while (this.answeredBridge.size > Sessions.ANSWERED_CAP) this.answeredBridge.delete(this.answeredBridge.keys().next().value!);
  }

  private wasAnsweredBridge(id: string, requestId: string): boolean {
    return this.answeredBridge.has(`${id}/${requestId}`);
  }

  /** Remember a phone message id so later resend checks hit memory instead of the log. Bounded. */
  private rememberClientMsgId(id: string, clientMsgId: string): void {
    let set = this.seenIds.get(id);
    if (!set) { set = new Set(); this.seenIds.set(id, set); }
    set.add(clientMsgId);
    while (set.size > Sessions.SEEN_INDEX_CAP) set.delete(set.values().next().value!);
  }

  private seen(id: string, clientMsgId: string): boolean {
    // Warm index (this process appended every user event in it): absence means absent, no scan.
    if (this.seenIds.get(id)?.has(clientMsgId)) return true;
    if (this.seenIds.has(id)) return false;
    // Cold index (after a restart): scan from the end, where a resend's original is, and warm
    // the index with the ids the scan passes over.
    const log = this.log(id);
    const collected: string[] = [];
    let before = log.lastSeq + 1;
    for (let pages = 0; pages < 8 && before > 1; pages++) {
      const page = log.before(before);
      for (const e of page.events) {
        if (e.kind !== "user" || !e.clientMsgId) continue;
        if (collected.length < Sessions.SEEN_INDEX_CAP) collected.push(e.clientMsgId);
        if (e.clientMsgId === clientMsgId) { this.rememberClientMsgId(id, clientMsgId); return true; }
      }
      if (!page.hasOlder || !page.events.length) break;
      before = page.events[0]!.seq;
    }
    this.seenIds.set(id, new Set(collected));
    return false;
  }

  decide(id: string, permId: string, decision: "allow" | "allow_always" | "deny", message?: string, answers?: Record<string, string>, reqId?: string): boolean | Promise<boolean> {
    // The CLI request id survives host/card recreation. Neither a new phone reqId nor a
    // new local permission id may repeat a write whose first outcome remains unknown.
    const localKey = `decide:${id}:${permId}`;
    if (this.receipts.status(localKey) === "completed") return reqId !== undefined;
    const connection = this.bridges.get(id);
    const request = connection && [...connection.permissions].find(([, value]) => value.id === permId);
    const key = request ? JSON.stringify(["decide_bridge", id, connection!.bridgeId, request[0]]) : localKey;
    if (this.receipts.status(key) === "completed") {
      this.opts.permissions.expire(permId, "cancelled");
      return reqId !== undefined;
    }
    if (this.receipts.status(key) === "pending") {
      const pending = this.bridgeDecisions.get(permId);
      if (pending) return pending;
      throw new OutcomeUnknownError();
    }
    const result = this.decideOnce(id, permId, decision, message, answers, key);
    return result;
  }

  private decideOnce(id: string, permId: string, decision: "allow" | "allow_always" | "deny", message: string | undefined, answers: Record<string, string> | undefined, key: string): boolean | Promise<boolean> {
    if (decision !== "allow" && decision !== "allow_always" && decision !== "deny") throw new Error("invalid decision");
    if (decision === "allow_always" && !this.permissionRules.get(permId)?.length) throw new Error("이 요청에는 안전한 세션 허용 규칙이 없습니다");
    const connection = this.bridges.get(id);
    const pending = connection && [...connection.permissions].find(([, value]) => value.id === permId);
    if (connection && pending) {
      const sending = this.bridgeDecisions.get(permId);
      if (sending) return sending;
      const answer = this.decideBridge(id, permId, decision, pending[0], pending[1], key, message, answers)
        .then(ok => {
          if (ok) { this.receipts.complete(key); this.receipts.complete(`decide:${id}:${permId}`, id); this.clearPermissionAttention(id); }
          else this.receipts.abandon(key);
          return ok;
        })
        .finally(() => this.bridgeDecisions.delete(permId));
      this.bridgeDecisions.set(permId, answer);
      return answer;
    }
    const p = this.opts.permissions.get(permId);
    if (!p || p.session !== id || p.state !== "pending") return false;
    if (p.tool === "ExitPlanMode" && decision !== "deny") return this.implementPlan(id, permId).then(ok => { if (ok) this.receipts.complete(key, id); return ok; });
    if (p.tool === "AskUserQuestion" && decision !== "deny") {
      const questions = questionInputs(object(p.input) ?? {});
      if (!answers || !questions.length || questions.some(q => typeof answers[q.question] !== "string" || !answers[q.question]!.trim())) throw new Error("Answer every question before submitting.");
      if (Object.values(answers).some(value => typeof value !== "string")) throw new Error("Invalid question answers.");
    }
    const decided = this.opts.permissions.decide(permId, decision, message, answers) !== null;
    if (decided) { this.receipts.complete(key, id); this.clearPermissionAttention(id); }
    return decided;
  }

  private planDecisions = new Map<string, Promise<boolean>>();

  private implementPlan(id: string, permId: string): Promise<boolean> {
    const pending = this.planDecisions.get(permId);
    if (pending) return pending;
    const change = this.inSessionLane(id, async turn => {
      if (this.opts.permissions.get(permId)?.state !== "pending") return false;
      const r = this.records.get(id)!;
      const previousMode = r.permissionMode ?? "auto";
      const previousPrePlanMode = r.prePlanMode;
      await this.changeMode(id, r.prePlanMode === "bypassPermissions" || r.permissionMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits", turn);
      turn.check();
      let approved = false;
      try {
        approved = this.opts.permissions.decide(permId, "allow") !== null;
        if (approved) this.clearPermissionAttention(id);
        return approved;
      } finally {
        if (!approved) {
          // Cancellation/expiry or a failed durable decision can win during the SDK request.
          // Roll back in this lane before a later user mode change runs.
          await this.changeMode(id, previousMode, turn);
          turn.check();
          if (previousPrePlanMode === undefined) delete r.prePlanMode;
          else r.prePlanMode = previousPrePlanMode;
          this.save();
        }
      }
    });
    this.planDecisions.set(permId, change);
    void change.finally(() => this.planDecisions.delete(permId)).catch(() => {});
    return change;
  }

  /** The control_response the Remote Control side accepts for a permission answer (bridge-client.ts post). */
  private bridgeDecisionPayload(requestId: string, pending: { input: Record<string, unknown>; toolUseId: string }, decision: "allow" | "deny", message?: string, updatedInput: Record<string, unknown> = pending.input, rules?: ReturnType<typeof sessionPermissionRules>): Record<string, unknown> {
    return { type: "control_response", uuid: randomUUID(), response: { subtype: "success", request_id: requestId, response: { behavior: decision, updatedInput, toolUseID: pending.toolUseId, ...(rules?.length ? { updatedPermissions: rules } : {}), ...(message ? { message } : {}) } } };
  }

  private async decideBridge(id: string, permId: string, decision: "allow" | "allow_always" | "deny", requestId: string, pending: BridgePending, receiptKey: string, message?: string, answers?: Record<string, string>): Promise<boolean> {
    const connection = this.bridges.get(id);
    if (!connection || connection.failed || this.opts.permissions.get(permId)?.state !== "pending") return false;
    if (decision === "allow_always" && !pending.rules.length) throw new Error("이 요청에는 안전한 세션 허용 규칙이 없습니다");
    // The phone answers AskUserQuestion the way the host path does: every question filled in, and
    // the answers merged into the tool input the Remote Control side is told to run (#82).
    const record = this.opts.permissions.get(permId);
    let questions: Question[] | null = null;
    if (record?.tool === "AskUserQuestion" && decision !== "deny") {
      try { questions = questionInputs(object(record.input) ?? {}); } catch { questions = null; }
      if (questions) {
        if (!answers || !questions.length || questions.some(q => typeof answers[q.question] !== "string" || !answers[q.question]!.trim())) throw new Error("Answer every question before submitting.");
        if (Object.values(answers).some(value => typeof value !== "string")) throw new Error("Invalid question answers.");
      }
    }
    const updatedInput = answers ? { ...pending.input, answers } : pending.input;
    // A plan card's "keep planning" sends the person's feedback as the denial, as the host path does.
    const denial = message || "The user denied this from their phone.";
    this.receipts.begin(receiptKey, id);
    try {
      await this.bridge.post(connection.bridgeId, this.bridgeDecisionPayload(requestId, pending, decision === "deny" ? "deny" : "allow", decision === "deny" ? denial : undefined, updatedInput, decision === "allow_always" ? pending.rules : undefined));
    } catch (error) {
      this.bridgeFailure(id, error);
      if (bridgeWriteUnknown(error)) throw new OutcomeUnknownError();
      this.receipts.abandon(receiptKey);
      throw error;
    }
    connection.permissions.delete(requestId);
    this.rememberAnsweredBridge(id, requestId);
    return this.opts.permissions.decide(permId, decision, undefined, answers) !== null;
  }

  /**
   * A new message from the phone supersedes waiting Mac approvals, as host sessions do
   * (parity doc phase 1: "승인 대기 중에 새 메시지 → 대기 승인 거부"). Each open request gets
   * the deny control_response the Remote Control side accepts, and the local record resolves
   * denied the same way the host path's denySession resolves it.
   */
  private supersedeBridge(id: string, connection: { bridgeId: string; abort: AbortController; failed: boolean; permissions: Map<string, BridgePending> }): void {
    const reason = "superseded by a new message from the user";
    for (const [requestId, pending] of [...connection.permissions]) {
      connection.permissions.delete(requestId);
      this.rememberAnsweredBridge(id, requestId);
      void this.bridge.post(connection.bridgeId, this.bridgeDecisionPayload(requestId, pending, "deny", "The user superseded this with a new message."))
        .catch(error => this.bridgeFailure(id, error));
      this.opts.permissions.decide(pending.id, "deny", reason);
    }
    this.clearPermissionAttention(id);
  }

  async interrupt(id: string): Promise<void> {
    const bridgeId = this.desktop?.liveProcess(this.records.get(id)?.sdkSessionId ?? id)?.bridgeSessionId;
    if (!this.bridges.has(id) && bridgeId) { this.log(id); this.ensureBridge(id, bridgeId); }
    const connection = this.bridges.get(id);
    if (connection) {
      if (connection.failed) throw new DesktopBlockedError();
      try { await this.bridge.interrupt(connection.bridgeId); }
      catch (error) { this.bridgeFailure(id, error); throw error; }
      this.append(id, { kind: "notice", code: "interrupted" });
      return;
    }
    const live = this.live.get(id);
    if (!live) {
      // The app runs this turn and no channel here can stop it: say so rather than report a stop.
      const r = this.records.get(id);
      const appRun = r && !r.desktopBridge && this.canTailHandoff(r) ? this.desktop?.liveProcess(r.sdkSessionId!) : undefined;
      if (appRun && appRun.status !== "idle") throw new Error(APP_STOP);
      return;
    }
    // Open requests resolve as expired; their canUseTool continuation writes the event.
    this.opts.permissions.expireSession(id, "aborted");
    const r = this.records.get(id);
    // Only a running turn can be stopped; a flag set while idle would swallow the next real result.
    if (!r || (r.state !== "running" && r.state !== "waiting")) return;
    live.interrupted = true;
    live.input.close();
    const handoff = this.handingOff.get(id);
    if (handoff) handoff.messages = [];
    await live.ready;
    try { if (this.live.get(id) === live) await live.query.interrupt(); }
    finally {
      // A result may have retired this query and another send may already have started one.
      // A late interrupt completion owns only its original query, never the replacement.
      if (this.live.get(id) === live) {
        this.stop(id, live);
        this.setState(r, "idle");
      }
    }
    this.append(id, { kind: "notice", code: "interrupted" });
  }

  private sessionLanes = new Map<string, Promise<void>>();

  /** One FIFO per session. Only running time counts toward an item's single deadline.
   * Expiry releases the lane and invalidates the token, even if upstream never answers, and the
   * caller hears "not confirmed" unless `answerAtExpiry` is false (it then gets the work's own
   * outcome). Either way the work goes on: a message already handed on still records its receipt
   * and log entry, so only the token's pre-send checks stop one that was not. */
  private inSessionLane<T>(id: string, work: (token: LaneToken) => T | Promise<T>, answerAtExpiry = true): Promise<T> {
    const previous = this.sessionLanes.get(id);
    const result = Promise.withResolvers<T>();
    const released = Promise.withResolvers<void>();
    const tail = released.promise.then(() => {
      if (this.sessionLanes.get(id) === tail) this.sessionLanes.delete(id);
    });
    this.sessionLanes.set(id, tail);
    const start = async (): Promise<void> => {
      let current = true;
      const token: LaneToken = { check: () => {
        if (!current || this.shuttingDown) throw new OutcomeUnknownError();
      } };
      const timer = setTimeout(() => {
        current = false;
        released.resolve();
        if (answerAtExpiry) result.reject(new OutcomeUnknownError());
      }, LANE_ITEM_MS);
      try {
        token.check();
        result.resolve(await work(token));
      } catch (error) { result.reject(error); }
      finally { current = false; clearTimeout(timer); released.resolve(); }
    };
    // Register before starting, and start synchronously when idle: frames in one read keep order.
    if (previous) void previous.then(start);
    else void start();
    return result.promise;
  }

  setMode(id: string, mode: PermissionMode, reqId: string = randomUUID()): Promise<SettingsResult> {
    if (!this.has(id)) return Promise.reject(new Error("no such session"));
    return this.settings.run(id, reqId, JSON.stringify(["mode", mode]), "permissionMode", () => this.inSessionLane(id, async turn => {
      await this.changeMode(id, mode, turn);
      turn.check();
      return { status: "applied", permissionMode: mode };
    }), result => { if (!this.shuttingDown) this.append(id, { kind: "settings", reqId, ...result }); });
  }

  /** Import the desktop log before controlling it, but never start or restart its worker. */
  private settingsBridge(id: string, allowAppSettings = false): string | null {
    if (this.shuttingDown) throw new OutcomeUnknownError();
    // Adoption waits for the SDK's accepted turns to finish (pollDesktop). A settings
    // change cannot rebase its log out from under that still-active transcript writer.
    if (this.live.has(id) || this.handingOff.has(id)) return null;
    const r = this.records.get(id);
    const desktopId = r?.sdkSessionId ?? id;
    const bridgeId = r?.environmentBridgeId ?? this.desktop?.liveProcess(desktopId)?.bridgeSessionId;
    if (bridgeId) {
      this.log(id);
      if (r && !r.desktopBridge) this.rebaseDesktop(r);
      this.ensureBridge(id, bridgeId);
      return bridgeId;
    }
    if ((r?.desktopBridge || this.desktop?.isOpen(desktopId)) && !(allowAppSettings && this.desktopSettings?.appSessionIdFor(desktopId))) throw new DesktopBlockedError();
    return null;
  }

  private async changeMode(id: string, mode: PermissionMode, turn: LaneToken): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) throw new Error("invalid permission mode");
    const bridgeId = this.settingsBridge(id);
    const r = this.records.get(id) ?? this.continueDesktop(id, "");
    if (bridgeId) {
      turn.check();
      await this.bridge.control(bridgeId, randomUUID(), { subtype: "set_permission_mode", mode });
      turn.check();
      this.recordMode(r, mode);
      return;
    }
    const live = this.live.get(id);
    if (!live && mode === "bypassPermissions" && !(r.bypassAllowed ?? r.permissionMode === "bypassPermissions")) throw new Error("bypass_not_launched");
    if (live) {
      await live.ready;
      turn.check();
      if (this.live.get(id) !== live) throw new Error("The session stopped before its mode changed. Try again.");
      await live.query.setPermissionMode(mode);
      turn.check();
    }
    this.recordMode(r, mode);
  }

  private recordMode(r: SessionRecord, mode: PermissionMode): void {
    if (mode === "plan" && r.permissionMode !== "plan") r.prePlanMode = r.permissionMode ?? "auto";
    if (mode !== "plan") delete r.prePlanMode;
    r.bypassAllowed ??= r.permissionMode === "bypassPermissions";
    r.permissionMode = mode;
    r.confirmedSettings = { ...r.confirmedSettings, permissionMode: mode };
    this.save();
    this.append(r.id, { kind: "mode", mode });
    this.opts.onSessions();
  }

  setModel(id: string, model: string, effort: Effort | null, reqId: string = randomUUID()): Promise<SettingsResult> {
    if (!this.has(id)) return Promise.reject(new Error("no such session"));
    if (typeof model !== "string" || !model.trim() || model.length > 300 || /[@\s]/.test(model)) return Promise.reject(new Error("Invalid model"));
    if (effort !== null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) return Promise.reject(new Error("Invalid effort"));
    return this.settings.run(id, reqId, JSON.stringify(["model", model, effort]), "model", () => this.inSessionLane(id, turn => this.changeModel(id, model, effort, turn)),
      result => { if (!this.shuttingDown) this.append(id, { kind: "settings", reqId, ...result }); });
  }

  private async changeModel(id: string, model: string, effort: Effort | null, turn: LaneToken): Promise<SettingsResult> {
    const bridgeId = this.settingsBridge(id, true);
    const m = modelArg(model, effort);
    if (bridgeId) {
      const r = this.records.get(id)!;
      turn.check();
      await this.bridge.control(bridgeId, randomUUID(), { subtype: "set_model", model: m.model });
      turn.check();
      if (r.model !== model) r.contextWindow = null;
      r.model = model;
      r.confirmedSettings = { ...r.confirmedSettings, model };
      this.save();
      this.opts.onSessions();
      // Claude's effort is a distinct CLI setting, never a thinking-token budget. Routed
      // models carry it ONLY in modelArg, so there cannot be a second conflicting setting.
      if (isClaudeModel(model)) {
        try {
          turn.check();
          await this.bridge.control(bridgeId, randomUUID(), { subtype: "apply_flag_settings", settings: { effortLevel: effort } });
        }
        catch (error) {
          if (error instanceof OutcomeUnknownError) throw error;
          turn.check();
          if (r.sdkSessionId) this.queueAppChoice(id, r.sdkSessionId, model, r.effort);
          return { status: "partial", model, errors: { effort: error instanceof Error ? error.message : String(error) } };
        }
      }
      turn.check();
      r.effort = effort;
      r.confirmedSettings = { ...r.confirmedSettings, effort };
      this.save();
      if (r.sdkSessionId) this.queueAppChoice(id, r.sdkSessionId, model, effort);
      this.opts.onSessions();
      return { status: "applied", model, effort };
    }
    if (isClaudeModel(model) && effort !== null && m.effort === undefined) throw new Error("이 SDK 경로에서는 해당 Claude 추론 강도를 지원하지 않습니다");
    if (!this.records.has(id) && this.desktop?.has(id)) {
      if (this.desktopSettings?.appSessionIdFor(id)) {
        // A settings-only import keeps the phone's choice and failure notices across restarts.
        const record = this.continueDesktop(id, "", true, true);
        record.model = model; record.effort = effort;
        record.confirmedSettings = { ...record.confirmedSettings, model, effort };
        this.save();
        this.queueAppChoice(id, id, model, effort);
      } else this.desktopModels.set(id, { model, effort });
      this.opts.onSessions();
      return { status: "applied", model, effort };
    }
    const r = this.records.get(id);
    if (!r) throw new Error("no such session");
    const changedModel = r.model !== model;
    const changedEffort = r.effort !== effort;
    const live = this.live.get(id);
    const needsRestart = !!live && isClaudeModel(model) && (changedModel || changedEffort || live.restartAfterTurn);
    if (needsRestart && !live.restartAfterTurn) {
      r.confirmedSettings = { ...r.confirmedSettings, model: r.model, effort: r.effort };
    }
    if (live && !needsRestart && (changedModel || changedEffort && !isClaudeModel(model))) {
      await live.ready;
      turn.check();
      if (this.live.get(id) !== live) throw new Error("The session stopped before its model changed. Try again.");
      await live.query.setModel(m.model);
      turn.check();
    }
    if (changedModel) r.contextWindow = null;
    r.model = model;
    r.effort = effort;
    this.save();
    if (live && needsRestart) live.restartAfterTurn = true;
    else {
      if (live) live.restartAfterTurn = false;
      r.confirmedSettings = { ...r.confirmedSettings, model, effort };
    }
    this.save();
    if (!needsRestart && r.sdkSessionId) this.queueAppChoice(id, r.sdkSessionId, model, effort);
    if (live?.restartAfterTurn && (r.state === "idle" || r.state === "error")) this.restartSettings(r, live);
    const effective = this.effectiveSettings(r);
    if (!effective.pendingSettings) this.append(id, { kind: "notice", code: "model_changed", text: effort ? `${model} · ${effort}` : model });
    this.opts.onSessions();
    return effective.pendingSettings
      ? { status: "partial", model: effective.model, effort: effective.effort, pending: effective.pendingSettings }
      : { status: "applied", model, effort };
  }

  private markTranscriptEnd(r: SessionRecord): void {
    if (!r.sdkSessionId || !this.desktop) return;
    const end = this.desktop.transcriptEnd(r.sdkSessionId);
    if (end !== undefined && r.transcriptOffset !== end) { r.transcriptOffset = end; this.save(); }
  }

  stop(id: string, expected?: Live): void {
    const live = this.live.get(id);
    if (!live || (expected && live !== expected)) return;
    const r = this.records.get(id);
    const follow = r && !r.desktopBridge && !r.environmentBridgeId && r.desktopHandoff === "attempted";
    if (follow) this.closing.set(id, live);
    this.live.delete(id);
    if (!this.shuttingDown) this.invalidateActivity(id);
    live.input.close();
    live.abort.abort();
    try { live.query?.close(); } catch { /* already ended */ }
    const finished = () => {
      if (this.closing.get(id) !== live) return;
      if (!this.shuttingDown) this.markTranscriptEnd(r!);
      this.closing.delete(id);
    };
    if (follow && live.query?.processExited) void live.query.processExited.then(finished).catch(error => {
      (this.opts.log ?? console.error)(`[desktop tail] ${id}: writer exit failed: ${String(error)}`);
    });
    else if (follow) finished();
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.modInbox.close();
    this.settingsJobs.close();
    for (const timer of this.adoptionTimers.values()) clearTimeout(timer);
    this.adoptionTimers.clear();
    this.closeQueueWatch();
    for (const id of this.transcriptWatches.keys()) this.unwatchDesktop(id);
    this.bridgeRunning.clear();
    this.bridge.closeControls();
    for (const id of Array.from(this.live.keys())) this.stop(id);
    for (const id of this.bridges.keys()) this.closeBridge(id);
    for (const log of this.logs.values()) log.close();
    this.desktop?.close();
  }

  // ---- the query ----------------------------------------------------------------------------

  private start(r: SessionRecord): Live {
    if (r.sdkSessionId && this.desktop?.isOpen(r.sdkSessionId)) {
      if (!this.handedOff(r.id)) throw new DesktopBlockedError();
      if (this.appBusy(r.sdkSessionId)) throw new DesktopBusyError();
    }
    this.invalidateActivity(r.id);
    const abort = new AbortController();
    const input = new Inbox();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDECODE;
    const m = modelArg(r.model, r.effort);
    const options: Record<string, unknown> = {
      cwd: r.cwd,
      ...(!r.sdkSessionId ? { title: r.title } : {}),
      model: m.model,
      ...(m.effort ? { effort: m.effort } : {}),
      includePartialMessages: true,
      hooks: { Stop: [{ hooks: [async (input: Record<string, unknown>) => {
        if (this.shuttingDown || this.live.get(r.id) !== live || input.agent_id || !Array.isArray(input.background_tasks) && !Array.isArray(input.session_crons)) return {};
        const activity = this.taskState(r.id).activity;
        activity.inventory(input, this.now());
        this.append(r.id, { kind: "background", tasks: [...activity.active, ...activity.history], known: activity.known });
        if (live.restartAfterTurn && this.sdkIdle(r, live)) this.restartSettings(r, live);
        return {};
      }] }] },
      settingSources: ["user", "project", "local"],
      permissionMode: r.permissionMode ?? "auto",
      ...((r.bypassAllowed ?? r.permissionMode === "bypassPermissions") ? { allowDangerouslySkipPermissions: true } : {}),
      abortController: abort,
      env,
      canUseTool: this.canUseTool(r.id),
      stderr: (line: string) => { if (!line.includes("unrecognized_model")) process.stderr.write(`[session ${r.id.slice(0, 8)}] ${line}`); },
      ...(r.sdkSessionId ? { resume: r.sdkSessionId } : {}),
      ...(this.opts.claudePath ? { pathToClaudeCodeExecutable: this.opts.claudePath } : {}),
    };
    const live: Live = { query: null as unknown as SdkQuery, ready: Promise.resolve(), input, abort, buffer: null, flushTimer: null, current: null, subs: new Map(), turnStart: this.now(), restartAfterTurn: false, retried: false, interrupted: false, pendingMessages: [] };
    this.live.set(r.id, live);
    live.ready = this.opts.router.status().then((s) => {
      // The router's own word on where its proxy and CA are wins over whatever this process inherited.
      Object.assign(env, s.proxyEnv);
    }).finally(() => {
      if (this.live.get(r.id) !== live) return;
      live.query = this.opts.queryFn({ prompt: input, options });
      void this.consume(r, live);
    });
    return live;
  }

  private async consume(r: SessionRecord, live: Live): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const msg of live.query) {
        if (this.live.get(r.id) !== live) break;
        this.handle(r, live, msg);
      }
    } catch (e) {
      if (!live.abort.signal.aborted) failure = (e as Error).message;
    }
    if (this.live.get(r.id) !== live) return;
    this.flush(r.id, live);
    if (r.desktopHandoff === "attempted" && !r.desktopBridge && !r.environmentBridgeId) {
      try { await live.query.processExited; }
      catch (error) { (this.opts.log ?? console.error)(`[desktop tail] ${r.id}: writer exit failed: ${String(error)}`); return; }
      if (this.live.get(r.id) !== live) return;
      this.markTranscriptEnd(r);
    }
    this.live.delete(r.id);
    this.invalidateActivity(r.id);
    this.opts.permissions.expireSession(r.id, "aborted");
    if (failure) {
      const text = this.failureText(r.id, failure);
      this.append(r.id, { kind: "result", ok: false, error: text, ms: this.now() - live.turnStart, turns: 0 });
      this.setState(r, "error", text.slice(0, 300));
    } else if (r.state !== "idle" && r.state !== "error") this.setState(r, "stopped");
  }

  /**
   * The CLI's own words for "no login" become the host's, so a phone reads what to do about it.
   * The raw text stays in the host's own log line, where the exact CLI wording belongs.
   */
  private failureText(id: string, raw: string): string {
    if (!isCliNotLoggedIn(raw)) return raw;
    (this.opts.log ?? console.error)(`[session ${id.slice(0, 8)}] Claude Code CLI: ${raw.trim()}`);
    return CLI_NOT_LOGGED_IN;
  }

  private handle(r: SessionRecord, live: Live, msg: Record<string, unknown>): void {
    const parent = (msg.parent_tool_use_id as string | null | undefined) ?? null;
    switch (msg.type) {
      case "system": {
        const mode = PERMISSION_MODES.find(mode => mode === msg.permissionMode);
        if (!parent && mode && mode !== r.permissionMode && (msg.subtype === "init" || msg.subtype === "status")) this.recordMode(r, mode);
        if (msg.subtype === "init") {
          const list = slashCommands(msg);
          if (list) { this.commandLists.set(r.id, { at: this.now(), list }); this.lastCommands = list; }
        }
        if (msg.subtype === "init" && typeof msg.session_id === "string" && r.sdkSessionId !== msg.session_id) {
          r.sdkSessionId = msg.session_id;
          this.save();
          this.opts.onSessions();
        }
        if (msg.subtype === "api_retry" && !live.retried) { live.retried = true; this.append(r.id, { kind: "notice", code: "api_retry" }); }
        return;
      }
      case "stream_event": {
        if (parent) return;
        const ev = msg.event as { type?: string; index?: number; message?: { id?: string }; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
        if (ev?.type === "message_start" && ev.message?.id) {
          this.flush(r.id, live);
          live.current = { msg: ev.message.id, text: "", tools: [], model: this.effectiveSettings(r).model, thinkingBlocks: [], nextThinkingBlock: 0 };
        } else if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking" && live.current) {
          const index = ev.index ?? 0;
          if (!live.current.thinkingBlocks.includes(index)) live.current.thinkingBlocks.push(index);
        } else if (ev?.type === "content_block_delta" && live.current) {
          const thinking = ev.delta?.type === "thinking_delta" ? ev.delta.thinking : undefined;
          const text = ev.delta?.type === "text_delta" ? ev.delta.text : undefined;
          if (!thinking && !text) return;
          const block = ev.index ?? 0;
          if (thinking && !live.current.thinkingBlocks.includes(block)) live.current.thinkingBlocks.push(block);
          if (live.buffer && (text && live.buffer.thinking || thinking && (!live.buffer.thinking || live.buffer.thinking.block !== block))) this.flush(r.id, live);
          if (!live.buffer) live.buffer = { msg: live.current.msg, text: "" };
          if (thinking) {
            if (!live.buffer.thinking) live.buffer.thinking = { block, text: "" };
            live.buffer.thinking.text += thinking;
          } else if (text) live.buffer.text += text;
          if (!live.flushTimer) live.flushTimer = setTimeout(() => this.flush(r.id, live), this.opts.coalesceMs ?? 80);
        }
        return;
      }
      case "assistant": {
        const message = msg.message as { id?: string; model?: string; content?: { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
        if (!message) return;
        if (parent) { this.subAssistant(r, live, parent, message); return; }
        this.flush(r.id, live);
        const id = message.id ?? randomUUID();
        if (!live.current || live.current.msg !== id) live.current = { msg: id, text: "", tools: [], model: message.model ?? this.effectiveSettings(r).model, thinkingBlocks: [], nextThinkingBlock: 0 };
        const cur = live.current;
        (message.content ?? []).forEach((block, index) => {
          if (block.type !== "thinking" || typeof block.thinking !== "string") return;
          // SDK assistant messages can contain just one completed block: local index 0
          // is not necessarily the block's index in the original stream.
          const streamedIndex = cur.thinkingBlocks[cur.nextThinkingBlock++] ?? index;
          this.append(r.id, narrationBody(block, id, streamedIndex) ?? { kind: "thinking", msg: id, block: streamedIndex, text: block.thinking });
        });
        const converted = messageContent(message.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) });
        if (converted.text) cur.text += (cur.text ? "\n\n" : "") + converted.text;
        cur.images = [...(cur.images ?? []), ...converted.images];
        cur.files = [...(cur.files ?? []), ...converted.files];
        for (const b of message.content ?? []) {
          if (b.type === "tool_use" && b.id && b.name) {
            const input = b.input ?? {};
            const tool: ToolCall = { id: b.id, name: b.name, summary: summarize(b.name, input, r.cwd), input: JSON.stringify(input, null, 2), ...sessionFileTool(b.name, input, { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) }, data => this.log(r.id).image(data)) };
            cur.tools.push(tool);
            cur.images.push(...fileImages(tool.files ?? []));
            if (b.name === "Task" || b.name === "Agent") {
              const sub = { description: summarize(b.name, input, r.cwd), model: typeof input.model === "string" ? input.model : null, steps: 0 };
              live.subs.set(b.id, sub);
              this.append(r.id, { kind: "subagent", toolUseId: b.id, sub: `sub-${b.id}`, description: sub.description, model: sub.model, status: "running", steps: 0 });
            }
          }
        }
        if (message.model) cur.model = message.model;
        // Thinking-only SDK block completions must not reserve the answer's position
        // before subsequent thinking blocks have arrived.
        if (cur.text || cur.images.length || cur.files.length || cur.tools.length) this.append(r.id, { kind: "assistant", msg: cur.msg, model: cur.model, text: cur.text, images: cur.images, files: cur.files, tools: cur.tools });
        return;
      }
      case "user": {
        const message = msg.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? (message!.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) : [];
        const converted = messageContent(message?.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) });
        if (!parent && typeof converted.text === "string" && converted.text.startsWith("<task-notification>")) {
          const activity = this.taskState(r.id).activity;
          activity.notice(converted.text, this.now());
          this.append(r.id, { kind: "background", tasks: [...activity.active, ...activity.history], known: activity.known });
          for (const [notice] of converted.text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
            const taskId = /<task-id>([^<]+)<\/task-id>/.exec(notice)?.[1];
            const task = activity.history.find(task => task.id === taskId);
            const tool = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notice)?.[1] ?? task?.sub?.replace(/^sub-/, "");
            const status = /<status>([^<]+)<\/status>/.exec(notice)?.[1];
            if (tool && live.subs.has(tool) && ["completed", "failed", "killed", "stopped"].includes(status ?? "")) {
              this.workerEvent(r, live, tool, status === "completed" ? "done" : status === "failed" ? "failed" : "stopped");
              live.subs.delete(tool);
            }
          }
          if (live.restartAfterTurn && this.sdkIdle(r, live)) this.restartSettings(r, live);
          return;
        }
        // SDK user echoes normally already have a phone event; retain attachment-bearing echoes only.
        if (converted.images.length || converted.files.length) {
          const body: EventBody = { kind: "user", ...converted, clientMsgId: typeof msg.uuid === "string" ? msg.uuid : randomUUID() };
          if (parent) this.subLog(r.id, `sub-${parent}`)?.append(body);
          else this.append(r.id, body);
        }
        for (const b of blocks) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          const body: EventBody = { kind: "tool_result", toolUseId: b.tool_use_id, ok: !b.is_error, ...messageContent(b.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) }) };
          if (parent) this.subLog(r.id, `sub-${parent}`)?.append(body);
          else this.append(r.id, body);
          const sub = live.subs.get(b.tool_use_id);
          const resultText = typeof body.text === "string" ? body.text : "";
          const launch = !b.is_error && (toolInput(resultText)?.isAsync === true || /(?:launched asynchronously|async(?: agent)? launched)/i.test(resultText));
          if (sub && !launch) {
            this.workerEvent(r, live, b.tool_use_id, b.is_error ? "failed" : "done");
            live.subs.delete(b.tool_use_id);
          }
        }
        return;
      }
      case "result": {
        live.pendingMessages.shift();
        this.flush(r.id, live);
        live.current = null;
        live.retried = false;
        if (live.interrupted) {
          // The person pressed Stop; the "interrupted" notice already says so. A failed-turn line would not be true.
          this.stop(r.id, live);
          this.setState(r, "idle");
          return;
        }
        const ok = msg.subtype === "success" && msg.is_error !== true;
        const usage = msg.modelUsage as Record<string, { contextWindow?: number }> | undefined;
        const win = Object.entries(usage ?? {}).find(([model]) => windowKey(model) === windowKey(this.effectiveSettings(r).model))?.[1].contextWindow;
        r.contextWindow = typeof win === "number" && Number.isFinite(win) && win > 0 ? win : null;
        for (const [model, u] of Object.entries(usage ?? {})) if (typeof u.contextWindow === "number") this.learnWindow(model, u.contextWindow);
        const error = ok ? undefined : this.failureText(r.id, String(msg.result ?? (Array.isArray(msg.errors) ? msg.errors.join("; ") : msg.subtype ?? "error"))).slice(0, 500);
        this.append(r.id, { kind: "result", ok, ...(error ? { error } : {}), ms: typeof msg.duration_ms === "number" ? msg.duration_ms : this.now() - live.turnStart, turns: typeof msg.num_turns === "number" ? msg.num_turns : 0 });
        if (live.restartAfterTurn) this.restartSettings(r, live);
        this.setState(r, live.pendingMessages.length > 0 ? "running" : ok ? "idle" : "error");
        if (live.pendingMessages.length === 0) this.handoff(r, live);
        // While the app holds this conversation, a process kept between turns would answer from its
        // own last line: on 2026-10-25 a phone turn skipped the desktop's turn that way. Let it go,
        // so the next phone turn resumes from the transcript (issue #102). Background work keeps it.
        if (this.live.get(r.id) === live && live.pendingMessages.length === 0 && this.handedOff(r.id) && r.sdkSessionId &&
          this.desktop?.isOpen(r.sdkSessionId) && this.taskState(r.id).activity.active.length === 0) this.stop(r.id, live);
        void this.refreshFigures(r, true);
        return;
      }
      default:
        return;
    }
  }

  /** A settings restart shares the handoff inbox: preserve even prefetched accepted inputs,
   * and do not create another transcript writer until the old process has actually exited. */
  private restartSettings(r: SessionRecord, live: Live): void {
    if (this.live.get(r.id) !== live || this.taskState(r.id).activity.active.length) return;
    const transfer = { messages: live.pendingMessages };
    this.handingOff.set(r.id, transfer);
    this.stop(r.id, live);
    r.confirmedSettings = { ...r.confirmedSettings, model: r.model, effort: r.effort };
    this.save();
    if (r.sdkSessionId) this.queueAppChoice(r.id, r.sdkSessionId, r.model, r.effort);
    void Promise.resolve(live.query.processExited).then(async () => {
      this.handingOff.delete(r.id);
      if (this.shuttingDown) return;
      if (transfer.messages.length) await this.resumeAfterHandoff(r, transfer.messages);
      else this.handoff(r, live);
    }).catch(error => {
      this.handingOff.delete(r.id);
      if (this.shuttingDown) return;
      const text = error instanceof Error ? error.message : String(error);
      this.append(r.id, { kind: "result", ok: false, error: text, ms: 0, turns: 0 });
      this.setState(r, "error", text);
    });
  }

  /** Shared with app-bridge adoption: never stop a query still owed an accepted turn. */
  /** A phone session this host started and gave to the app for its list, with no Remote Control. */
  private handedOff(id: string): boolean {
    const r = this.records.get(id);
    return !!r && !r.desktopBridge && r.desktopHandoff !== undefined;
  }

  /**
   * Whether the app is running a turn in this conversation now, from a fresh registry read (the
   * cached one is up to a second old). A holder with no registry status is taken as working. While
   * the app is idle the host may resume the session: the app reads the transcript afresh at its next
   * turn, so its turn follows the phone's (2026-10-25, session 0cac4b9b). The router lookup in
   * start() still runs between this check and the SDK spawn; that window is milliseconds.
   */
  private appBusy(desktopId: string): boolean {
    if (!this.desktop) return false;
    const process = this.desktop.liveProcess(desktopId, 0);
    return process ? process.status !== "idle" : this.desktop.isOpen(desktopId);
  }

  private sdkIdle(r: SessionRecord, live = this.live.get(r.id)): boolean {
    return !this.handingOff.has(r.id) && !BUSY.has(r.state) && (!live || live.pendingMessages.length === 0) && this.taskState(r.id).activity.active.length === 0;
  }

  private handoff(r: SessionRecord, live = this.live.get(r.id)): void {
    const runner = this.opts.handoff;
    if (!runner || !r.sdkSessionId || r.desktopBridge || this.archived.has(r.id) || !this.sdkIdle(r, live) || this.handingOff.has(r.id)) return;
    if (r.desktopHandoff !== "pending" && r.desktopHandoff !== "failed") return;
    // An app worker already owns it, even when RC is off: do not open another writer.
    if (this.desktop?.isOpen(r.sdkSessionId)) {
      r.desktopHandoff = "attempted";
      if (live) this.stop(r.id, live);
      else this.markTranscriptEnd(r);
      delete r.desktopHandoffRetryAt;
      delete r.desktopHandoffError;
      this.save();
      return;
    }
    if ((r.desktopHandoffAttempts ?? 0) >= 3) return;
    r.desktopHandoff = "opening";
    r.desktopHandoffAttempts = (r.desktopHandoffAttempts ?? 0) + 1;
    this.save();
    const transfer = { messages: [] as SdkUserMessage[] };
    this.handingOff.set(r.id, transfer);
    // Reserve the send lane now, then let the SDK finish its result continuation.
    void new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (this.shuttingDown) { this.handingOff.delete(r.id); return; }
      try {
        // SDK events can arrive between result and this deferred callback. Recheck before aborting.
        if (BUSY.has(r.state) || this.taskState(r.id).activity.active.length || this.live.get(r.id) !== live) {
          r.desktopHandoff = "pending";
          r.desktopHandoffAttempts!--;
          this.save();
          return;
        }
        this.stop(r.id, live);
        // close() and iterator completion alone do not prove the writer has stopped.
        // The SDK owns the graceful-exit/kill deadline; never launch another writer before exit.
        await live?.query.processExited;
        if (this.shuttingDown || r.desktopBridge) return;
        const result = await runner({ sessionId: r.sdkSessionId!, title: r.title, cwd: r.cwd });
        if (this.shuttingDown) return;
        r.desktopHandoff = "attempted";
        delete r.desktopHandoffError;
        delete r.desktopHandoffRetryAt;
        this.markTranscriptEnd(r);
        this.save();
        this.append(r.id, { kind: "notice", code: "desktop_handoff_requested" }, false);
        (this.opts.log ?? console.error)(`[desktop handoff ${r.id}] ${result}`);
      } catch (error) {
        if (this.shuttingDown) return;
        r.desktopHandoff = "failed";
        r.desktopHandoffError = error instanceof Error ? error.message : String(error);
        r.desktopHandoffRetryAt = this.now() + 30_000;
        this.save();
        this.append(r.id, { kind: "notice", code: r.desktopHandoffAttempts! < 3 ? "desktop_handoff_retry" : "desktop_handoff_failed" }, false);
        (this.opts.log ?? console.error)(`[desktop handoff ${r.id}] failed: ${r.desktopHandoffError} (attempt ${r.desktopHandoffAttempts}/3)`);
      } finally {
        this.handingOff.delete(r.id);
        if (transfer.messages.length && !this.shuttingDown) await this.resumeAfterHandoff(r, transfer.messages);
        if (!this.shuttingDown) void this.drainQueue(r.id);
      }
    });
  }

  private async resumeAfterHandoff(r: SessionRecord, messages: SdkUserMessage[]): Promise<void> {
    try {
      this.desktop?.poll();
      const bridgeId = this.desktop?.liveProcess(r.sdkSessionId!)?.bridgeSessionId;
      if (bridgeId) {
        // The app is now the writer. Use the existing send path, never resume a second SDK.
        if (!r.desktopBridge) this.rebaseDesktop(r);
        for (const message of messages) {
          const content = messageContent(message.message.content, data => this.log(r.id).image(data));
          await this.sendBridge(r.id, message.uuid!, content.text, content.images.map(image => ({ blob: image.blob!, name: "photo", mediaType: image.mediaType })), bridgeId);
        }
        return;
      }
      const writer = this.live.get(r.id) ?? this.start(r);
      writer.pendingMessages.push(...messages);
      for (const message of messages) writer.input.push(message);
    } catch (error) {
      // Accepted inputs must get a visible failure if the app is open but not reachable yet.
      const text = error instanceof Error ? error.message : String(error);
      (this.opts.log ?? console.error)(`[desktop handoff ${r.id}] queued input failed: ${text}`);
      this.append(r.id, { kind: "result", ok: false, error: text, ms: 0, turns: 0 });
      this.setState(r, "error", text);
    }
  }

  private subAssistant(r: SessionRecord, live: Live, parent: string, message: { id?: string; model?: string; content?: { type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: Record<string, unknown> }[] }): void {
    const log = this.subLog(r.id, `sub-${parent}`);
    if (!log) return;
    (message.content ?? []).forEach((block, index) => {
      if (block.type === "thinking" && typeof block.thinking === "string") log.append(narrationBody(block, message.id ?? parent, index) ?? { kind: "thinking", msg: message.id ?? parent, block: index, text: block.thinking });
    });
    const converted = messageContent(message.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) });
    const tools = (message.content ?? []).filter((b) => b.type === "tool_use" && b.id && b.name).map((b): ToolCall => ({ id: b.id!, name: b.name!, summary: summarize(b.name!, b.input ?? {}, r.cwd), input: JSON.stringify(b.input ?? {}, null, 2), ...sessionFileTool(b.name!, b.input ?? {}, { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) }, data => log.image(data)) }));
    converted.images.push(...fileImages(tools.flatMap(tool => tool.files ?? [])));
    log.append({ kind: "assistant", msg: message.id ?? randomUUID(), model: message.model ?? "", ...converted, tools });
    for (const tool of tools) {
      if (tool.name !== "Agent" && tool.name !== "Task") continue;
      const block = message.content?.find(block => block.id === tool.id);
      live.subs.set(tool.id, { description: tool.summary, model: typeof block?.input?.model === "string" ? block.input.model : null, steps: 0, parent });
      this.workerEvent(r, live, tool.id, "running");
    }
    const sub = live.subs.get(parent);
    if (!sub) return;
    sub.steps++;
    if (message.model && sub.model !== message.model) {
      const first = sub.model === null;
      sub.model = message.model;
      if (first) this.workerEvent(r, live, parent, "running");
    }
  }

  /** A worker's lifecycle belongs to the conversation that launched it, never the main timeline by default. */
  private workerEvent(r: SessionRecord, live: Live, toolUseId: string, status: "running" | "done" | "failed" | "stopped"): void {
    const sub = live.subs.get(toolUseId);
    if (!sub) return;
    const body: EventBody = { kind: "subagent", toolUseId, sub: `sub-${toolUseId}`, description: sub.description, model: sub.model, status, steps: sub.steps };
    if (sub.parent) this.subLog(r.id, `sub-${sub.parent}`)?.append(body);
    else this.append(r.id, body);
  }

  private flush(id: string, live: Live): void {
    if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = null; }
    const b = live.buffer;
    live.buffer = null;
    if (b?.thinking?.text) this.append(id, { kind: "thinking", msg: b.msg, block: b.thinking.block, text: b.thinking.text, delta: true });
    if (b && b.text) this.append(id, { kind: "delta", msg: b.msg, text: b.text });
    const r = this.records.get(id);
    if (r && r.state === "running") void this.refreshFigures(r, false);
  }

  private canUseTool(id: string): CanUseTool {
    return async (tool, input, opts) => {
      const r = this.records.get(id)!;
      const live = this.live.get(id);
      if (live) this.flush(id, live);
      let detail = permissionDetail(tool, input, r.cwd);
      if (tool === "Write" && typeof input.file_path === "string") {
        // What the write replaces, when it is a readable file of a size worth showing on a phone; any
        // failure keeps the plain listing rather than failing the approval itself.
        try {
          const file = path.resolve(r.cwd, input.file_path);
          if ((await fs.promises.stat(file)).size <= 256 * 1024) {
            const before = await fs.promises.readFile(file, "utf8");
            detail = permissionDetail("Edit", { file_path: input.file_path, old_string: before, new_string: input.content }, r.cwd);
          }
        } catch { /* new file, unreadable or gone: the plain listing stands */ }
      }
      const questions = tool === "AskUserQuestion" ? questionInputs(input) : undefined;
      const { record, decision } = this.opts.permissions.request({ session: id, tool, title: opts.title ?? "", summary: summarize(tool, input, r.cwd), input }, opts.signal);
      const rules = sessionPermissionRules(tool, opts.suggestions, opts.suppressAlwaysAllowRule);
      this.permissionRules.set(record.id, rules);
      this.append(id, { kind: "permission", id: record.id, tool, title: opts.title ?? "", summary: record.summary, input: detail, canAlways: rules.length > 0, ...(rules.length ? { alwaysAllow: { scope: "session" as const, summary: rules.flatMap(update => update.rules.map(rule => `${rule.toolName}(${rule.ruleContent})`)).join("\n") } } : {}), requestKind: tool === "ExitPlanMode" ? "plan" : tool === "AskUserQuestion" ? "question" : "tool", ...(questions ? { questions } : {}) });
      this.setState(r, "waiting");
      const answer = await decision;
      this.append(id, { kind: "permission_decided", id: record.id, decision: answer.decision, ...(answer.decision === "allow_always" ? { ruleStatus: "sent" as const } : {}), ...(answer.reason ? { reason: answer.reason } : {}) });
      this.permissionRules.delete(record.id);
      if (this.live.has(id) && this.opts.permissions.pending(id).length === 0) this.setState(r, "running");
      else this.opts.onSessions();
      if (answer.decision === "allow") return { behavior: "allow", updatedInput: answer.answers ? { ...input, answers: answer.answers } : input };
      if (answer.decision === "allow_always") return { behavior: "allow", updatedInput: answer.answers ? { ...input, answers: answer.answers } : input, ...(rules.length ? { updatedPermissions: rules } : {}) };
      if (answer.decision === "deny") return { behavior: "deny", message: answer.reason ?? "The user denied this from their phone." };
      return { behavior: "deny", message: "This permission request expired before anyone answered.", interrupt: true };
    };
  }

  /** The mod's figures as events in the same log, so a phone that reconnects sees what it missed. Throttled to one read per 15 s while a turn runs. */
  private async refreshFigures(r: SessionRecord, force: boolean): Promise<void> {
    if (!r.sdkSessionId) return;
    await this.readFigures(r.id, r.sdkSessionId, this.effectiveSettings(r).model, r.contextWindow, force, false);
  }

  /**
   * One read of the router's records for a session, appended when it changed. `id` is the host's id
   * for it, `cliId` the id Claude Code sends the router (`X-Claude-Code-Session-Id`). A Mac session
   * has no window of its own. The learned SDK value is only a legacy native fallback: RouterClient
   * prefers provider-bound router metadata, and never uses that cache for an unknown routed model.
   * `mac`: a session the router has no record of yet (an old one, from before it started) says nothing.
   */
  private async readFigures(id: string, cliId: string, model: string, contextWindow: number | null, force: boolean, mac: boolean): Promise<void> {
    const epoch = () => this.records.has(id) ? this.log(id).epoch : this.desktop?.snapshot(id)?.epoch ?? "";
    const scope = { at: this.now(), model, epoch: epoch(), cliId };
    const last = this.figuresAt.get(id);
    const changed = last && (last.model !== model || last.epoch !== scope.epoch || last.cliId !== cliId);
    if (!force && !changed && scope.at - (last?.at ?? 0) < 15_000) return;
    const hadFigures = this.lastFigures.has(id);
    if (changed) { this.lastFigures.delete(id); this.desktopFigures.delete(id); }
    this.figuresAt.set(id, scope);
    let figures: Figures;
    try { figures = await this.opts.router.figures(cliId, model, contextWindow ?? this.windows.get(windowKey(model)) ?? null); } catch { return; }
    // A replaced log/model or a newer read owns the next event, not this late reply.
    if (this.shuttingDown || this.figuresAt.get(id) !== scope || epoch() !== scope.epoch) return;
    const current = this.records.get(id);
    if (current && (this.effectiveSettings(current).model !== model || (current.sdkSessionId ?? id) !== cliId)) return;
    if (mac && !hadFigures && !figures.route && !figures.effort && !figures.workers.length) return;
    const { at: _at, ...rest } = figures;
    const key = JSON.stringify(rest);
    if (this.lastFigures.get(id) === key) return;
    this.lastFigures.set(id, key);
    if (this.records.has(id)) { this.append(id, { kind: "figures", figures }); return; }
    // No record, so no live log: the snapshot a phone is reading gets the event now, and every later snapshot is built with it.
    this.desktopFigures.set(id, figures);
    const snapshot = this.desktop?.snapshot(id);
    if (snapshot) this.opts.onEvent(id, snapshot.append({ kind: "figures", figures }));
  }
}
