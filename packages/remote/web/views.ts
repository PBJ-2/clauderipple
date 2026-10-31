// Screens as strings of markup. The app and the screenshot fixtures both call these, so the
// mockups in docs/media/remote are the shipped UI, not a drawing of it.
import type { BrowseResult, DiffFile, DiffScope, DiffView, Effort, FolderEntry, HostInfo, ProviderGroup, SessionEvent, SessionSummary, Text, ImagePart } from "../src/protocol.ts";
import type { LinkStatus } from "./conn.ts";
import type { OutboxEntry, PreservedItem } from "./outbox.ts";
import type { PushAvail } from "./pushstate.ts";
import { clock, duration, esc, folderName, icon, relTime, shortPath, toolIcon } from "./dom.ts";
import { t, lang } from "./i18n.ts";
import { activitySummary } from "../src/tool-details.ts";
import { activityOverview, activityStateKey } from "./activity.ts";
import { emptyQuestionDraft, questionAnswers, questionsComplete, type QuestionDraft } from "./question-answers.ts";
import type { Key } from "./i18n.ts";
import { markdown } from "./md.ts";
import { ripple, stateRing } from "./mascot.ts";
import { sidebarSections, sidebarState, sessionTitle, isPinned, searchSessions, PINNED_GROUP } from "./sidebar.ts";
import type { TimelineItem, SessionView, ToolView, WorkerItem } from "./timeline.ts";

export interface WorkerSheet {
  kind: "worker";
  worker: WorkerItem;
  items: TimelineItem[];
  loading: boolean;
  error: string;
  depth: number;
  scroll: number;
  expanded: Map<string, string | null>;
  /** Everything this frame has read of the worker's log, so a running worker costs only its new steps. */
  events?: SessionEvent[];
  /** The last seq held: the next read asks for what comes after it. */
  afterSeq?: number;
  /** The worker's launch instruction, once its blob was read (read once, not on every refresh). */
  prompt?: string;
  /** The worker item these items were drawn from, to notice when it has taken another step. */
  seen?: string;
}

export interface Draft { cwd: string | null; model: string | null; effort: Effort | null }

/** A Windows drive root as the browse list reports it — `E:\`, and `E:/` if it is spelled that way. */
function isDrivePath(p: string): boolean { return /^[A-Za-z]:[\\/]$/.test(p); }

export type Sheet =
  | WorkerSheet
  | { kind: "folder"; recent: FolderEntry[]; browse: BrowseResult | null; filter: string; loading: boolean; /** What is typed in the path field, before it is opened; absent follows the folder on screen. */ pathDraft?: string }
  /** One session's own actions, opened from its row's menu: pin, archive, put the unread mark back. */
  | { kind: "session"; id: string }
  /** The session folder's changes: either the file list, or one file's whole patch over it
   * (`open`), with `scroll` where the list was left. */
  | { kind: "diff"; view: DiffView | null; scope: DiffScope; loading: boolean; error: string; open: string | null; scroll: number }
  /** `auto` is the sheet's own choice of the host-wide automatic effort; it describes the intent,
   * not what a level field says. Absent on a host that cannot write mod settings. */
  | { kind: "model"; groups: ProviderGroup[]; recent: string[]; model: string | null; effort: Effort | null; forSession: string | null; auto?: boolean }
  /** Unsent messages kept from earlier connections: what is preserved, what this computer already
   * holds after an import, and any stored text that could not be read (never parsed, never sent). */
  | {
      kind: "recovery";
      step: "list" | "confirm";
      /** readable messages kept for other connections, not yet copied here; `key` is the opaque handle */
      candidates: PreservedItem[];
      /** messages already copied into this computer's queue; they wait to be sent by hand */
      recovered: OutboxEntry[];
      /** messages this computer holds because their outcome (or creation) is unconfirmed */
      held: OutboxEntry[];
      raw: string[];
      picked: Set<string>;
      /** index of the raw value shown in full, if any */
      shown: number | null;
      unavailable: boolean;
    };

/** What the home screen says about kept messages before the sheet is opened. */
export interface RecoverySummary { messages: number; raw: number; unavailable: boolean };

export interface UI {
  now: number;
  link: LinkStatus;
  host: HostInfo | null;
  home: string | undefined;
  sessions: SessionSummary[];
  groups?: string[] | undefined;
  draft: Draft;
  models: ProviderGroup[];
  sheet: Sheet | null;
  /** expanded tool outputs, by tool-use id, with the text once fetched */
  expanded: Map<string, string | null>;
  workersOpen: boolean;
  permOpen: Set<string>;
  questionDrafts?: Map<string, QuestionDraft>;
  deciding?: Set<string>;
  toast: string | null;
  /** Session ids pinned on this device, as listed in its storage. */
  pins: string[];
  /** Section keys folded on this device; the archive starts folded. */
  folded: string[];
  /** The home search field's text. */
  query: string;
  /** How many session rows the home list draws before offering more. */
  homeLimit: number;
  /** whether notifications can work here, and are on; null until known */
  push?: PushAvail | null;
  /** the person said "later" to the notification card */
  pushLater?: boolean;
  /** messages kept from earlier connections (a pairing change, or a replaced host key) */
  recovery?: RecoverySummary | null;
}

/** The archive's folding key; a stored key list uses it like any section name. */
export const ARCHIVE_KEY = "archive";
/** Session rows drawn at once on the home list: a thousand sessions cost what forty do. */
export const HOME_PAGE = 40;

// ---- small helpers -----------------------------------------------------------------------------

export function modelName(models: ProviderGroup[], id: string | null): string {
  if (!id) return t("chip.model");
  for (const g of models) for (const m of g.models) if (m.model === id) return m.name;
  return id;
}

function effortLabel(e: Effort | null): string {
  return e ? t(`effort.${e}` as Key) : "";
}

function textOf(v: Text): string {
  return typeof v === "string" ? v : v.preview + "…";
}

/** A link is "lost" (not merely reconnecting) once it has been down for 30 s: say so plainly. */
export function linkKind(link: LinkStatus, now: number): "open" | "connecting" | "waiting" | "offline" | "denied" | "lost" {
  if (link.state === "open" || link.state === "denied" || link.state === "offline") return link.state;
  // A phone that slept or switched networks is often silent for half a minute; saying "lost" then
  // alarmed people over nothing (Discord, 2026-10-22). It is a calm wait, not an error, either way.
  if (link.downSince !== null && now - link.downSince > 60_000) return "lost";
  return link.state;
}

/** What copy calls the connected computer: its name once known, the neutral fallback before that. */
export function hostName(ui: UI): string {
  return ui.host?.name ?? t("host.fallback");
}

export function linkPill(ui: UI): string {
  const kind = linkKind(ui.link, ui.now);
  const host = hostName(ui);
  let label: string;
  if (kind === "open") label = t("conn.open");
  else if (kind === "offline") label = t("conn.offline");
  else if (kind === "denied") label = t("conn.denied.title");
  else if (ui.link.state === "waiting" && ui.link.nextAt) label = t("conn.retryIn", { s: Math.max(1, Math.ceil((ui.link.nextAt - ui.now) / 1000)) });
  else label = ui.link.attempt > 0 ? t("conn.retrying") : t("conn.connecting");
  return `<button class="link ${kind}" data-act="retry" aria-live="polite"><span class="dot"></span><span class="host">${esc(host)}</span><span>${esc(label)}</span></button>`;
}

/** The connection banner. Nothing when all is well; a slim line while retrying briefly; a card once it is a real outage. */
export function banner(ui: UI): string {
  const kind = linkKind(ui.link, ui.now);
  const seen = ui.link.lastRx ? t("conn.lastSeen", { time: clock(ui.link.lastRx) }) : "";
  if (kind === "open") {
    if (ui.host && !ui.host.routerOk) return `<div class="banner warn">${ripple("uneasy", 34)}<div class="txt">${esc(t("conn.router", { host: hostName(ui) }))}</div></div>`;
    if (ui.host?.desktopProblem) return `<div class="banner warn">${ripple("uneasy", 34)}<div class="txt">${esc(t("conn.desktop", { problem: ui.host.desktopProblem }))}</div></div>`;
    return "";
  }
  if (kind === "denied") {
    return `<div class="banner bad">${ripple("sorry", 40)}<div class="txt"><b>${esc(t("conn.denied.title"))}</b>${esc(t("conn.denied.body", { host: hostName(ui) }))}</div></div>`;
  }
  if (kind === "offline") {
    return `<div class="banner bad">${ripple("sleepy", 40)}<div class="txt"><b>${esc(t("conn.offline.title"))}</b>${esc(t("conn.offline.body"))}${seen ? `<small>${esc(seen)}</small>` : ""}</div></div>`;
  }
  if (kind === "lost") {
    const ago = duration(ui.now - (ui.link.downSince ?? ui.now));
    return `<div class="banner warn">${ripple("sleepy", 40)}<div class="txt"><b>${esc(t("conn.lost.title", { host: hostName(ui) }))}</b>${esc(t("conn.lost.body", { ago, host: hostName(ui) }))}${seen ? `<small>${esc(seen)}</small>` : ""}<div class="act"><button class="btn primary" data-act="retry">${esc(t("conn.retryNow"))}</button></div></div></div>`;
  }
  if (ui.link.attempt === 0) return "";
  return `<div class="banner slim">${icon.clock(16)}<span>${esc(ui.link.lastRx ? t("conn.stale", { time: clock(ui.link.lastRx) }) : t("conn.connecting"))}</span></div>`;
}

// ---- home --------------------------------------------------------------------------------------

/**
 * One session row. It is a wrapper because a row has two actions that must not be nested buttons:
 * opening the session (the whole row) and its own menu (the small button at the end).
 */
function sessionRow(s: SessionSummary, ui: UI): string {
  const tag = s.pending > 0
    ? `<span class="tag">${esc(t("state.waiting"))}${s.pending > 1 ? ` ${s.pending}` : ""}</span>`
    : s.state === "running" || s.state === "starting" ? `<span class="tag run">${esc(t("state.running"))}</span>` : "";
  return `<div class="rowwrap"><button class="row" data-act="open" data-id="${esc(s.id)}">${s.state === "error" && !s.pending ? ripple("sorry", 24) : stateRing(sidebarState(s), 24)}<div class="body"><div class="t1">${esc(s.title)}</div><div class="t2"><span>${esc(folderName(s.cwd, ui.home))}</span><span class="sep">·</span><span class="m">${esc(modelName(ui.models, s.model))}</span><span class="sep">·</span><span>${esc(relTime(s.updatedAt, ui.now))}</span></div></div>${tag}</button><button class="row-more" data-act="row-menu" data-id="${esc(s.id)}" aria-label="${esc(t("a11y.sessionMenu"))}" aria-haspopup="dialog">${icon.more(18)}</button></div>`;
}

/** A section's name. Pressing it folds the rows away and leaves the count, like the archive's row. */
function sectionHeader(key: string, name: string, count: number, folded: boolean, alwaysCount = false, foldable = true): string {
  const inner = `${esc(name)}${folded || alwaysCount ? `<span class="count">${count}</span>` : ""}`;
  return foldable
    ? `<button class="sec" data-act="fold" data-key="${esc(key)}" aria-expanded="${!folded}" aria-label="${esc(`${name}, ${count}`)}">${inner}${icon.chevron(14)}</button>`
    : `<div class="sec" role="heading" aria-level="2">${inner}</div>`;
}

/** The home's own list: results while searching, otherwise the pinned, recent and grouped sessions. */
export function homeList(ui: UI): string {
  const open = ui.link.state === "open";
  // While the link is down the states below are the last ones seen, and look it.
  const stale = open ? "" : " stale";
  const search = searchSessions(ui.sessions, ui.query, { listKnown: open || ui.sessions.length > 0 });
  if (search.kind === "unavailable") return `<div class="homenote">${esc(t("home.searchUnavailable"))}</div>`;
  if (search.kind === "none") return `<div class="homenote">${esc(t("home.searchNone"))}</div>`;
  if (search.kind === "results") {
    const shown = search.sessions.slice(0, ui.homeLimit);
    const more = search.sessions.length - shown.length;
    return `${sectionHeader("results", t("home.results"), search.sessions.length, false, true, false)}<div class="list${stale}">${shown.map(s => sessionRow(s, ui)).join("")}</div>${more > 0 ? pager(more) : ""}${open ? "" : `<div class="homenote">${esc(t("home.searchStale"))}</div>`}`;
  }
  const archived = ui.sessions.filter(s => s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const live = sidebarSections(ui.sessions, ui.groups, ui.now, { pins: ui.pins, folded: ui.folded });
  const out: string[] = [];
  let budget = ui.homeLimit, hidden = 0;
  const draw = (key: string, name: string, list: SessionSummary[], folded: boolean, alwaysCount = false): void => {
    if (folded) { if (budget > 0) out.push(sectionHeader(key, name, list.length, true, alwaysCount)); return; }
    if (budget <= 0) { hidden += list.length; return; }
    const shown = list.slice(0, budget);
    budget -= shown.length;
    hidden += list.length - shown.length;
    out.push(sectionHeader(key, name, list.length, false, alwaysCount));
    out.push(`<div class="list${stale}">${shown.map(s => sessionRow(s, ui)).join("")}</div>`);
  };
  for (const section of live) draw(section.key, section.name, section.sessions, section.folded);
  if (!live.length && archived.length) out.push(`<div class="homenote">${esc(t("home.allArchived"))}</div>`);
  if (archived.length) draw(ARCHIVE_KEY, t("home.showArchived"), archived, ui.folded.includes(ARCHIVE_KEY), true);
  if (!ui.sessions.length) out.push(`<div class="empty">${ripple("calm", 84)}<b>${esc(t("home.empty.title"))}</b><p>${esc(t("home.empty.body", { host: hostName(ui) }))}</p><div class="hint">${icon.down(22)}</div></div>`);
  if (hidden > 0) out.push(pager(hidden));
  return out.join("");
}

/** "Show more", saying how many rows are still waiting; the list draws HOME_PAGE more each time. */
function pager(more: number): string {
  return `<div class="pager"><button class="btn" data-act="home-more">${esc(t("home.moreCount", { n: more }))}</button></div>`;
}

export function homeMain(ui: UI): string {
  return `<div class="lt">${esc(t("home.title"))}</div>${banner(ui)}${homeSearch(ui)}<div id="home-list">${homeList(ui)}</div>${recoveryCard(ui)}${pushCard(ui)}<div style="height:12px"></div>`;
}

/** The search field, only once there is a list to search. It is outside the list so typing keeps the caret. */
function homeSearch(ui: UI): string {
  // A query someone already typed stays visible even if the list empties under it (a re-pair), so
  // the sentence about the missing list has the field it belongs to.
  if (!ui.sessions.length && !ui.query) return "";
  return `<div class="filter">${icon.search(18)}<input id="home-search" placeholder="${esc(t("home.search"))}" aria-label="${esc(t("home.search"))}" value="${esc(ui.query)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></div>`;
}

/** Below the list, near the thumb: turn notifications on, or what it takes on this phone. Gone once on or dismissed. */
export function pushCard(ui: UI): string {
  const p = ui.push;
  if (!p || p === "on" || p === "unsupported" || ui.pushLater) return "";
  const later = `<button class="btn ghost" data-act="push-later">${esc(t("push.later"))}</button>`;
  const body = p === "off" ? t("push.body") : p === "install" ? t("push.install") : p === "denied" ? t("push.denied") : t("push.insecure", { host: hostName(ui) });
  const action = p === "off" ? `<button class="btn primary" data-act="push-on">${icon.bell(18)}${esc(t("push.on"))}</button>` : "";
  return `<div class="banner push">${icon.bell(22)}<div class="txt"><b>${esc(t("push.title"))}</b>${esc(body)}<div class="act">${action}${later}</div></div></div>`;
}

export function homeTop(ui: UI): string {
  return `${linkPill(ui)}<span class="spacer"></span><button class="icon-btn" data-act="settings" aria-label="${esc(t("a11y.settings"))}">${icon.gear(21)}</button>`;
}

/** Kept messages from an earlier connection: where their words can be read and copied, never sent by themselves. */
export function recoveryCard(ui: UI): string {
  const r = ui.recovery;
  if (!r) return "";
  const line = r.unavailable
    ? t("outbox.storageUnavailable")
    : t("home.pending", { n: r.messages + r.raw });
  return `<button class="banner recovery" data-act="recovery-open">${icon.file(22)}<div class="txt"><b>${esc(t("recovery.title"))}</b>${esc(line)}</div>${icon.chevron(18)}</button>`;
}

export function chips(ui: UI): string {
  const folder = ui.draft.cwd ? folderName(ui.draft.cwd, ui.home) : t("chip.folder");
  const eff = ui.draft.effort ? `<span class="eff">${esc(effortLabel(ui.draft.effort))}</span>` : "";
  return `<div class="chips"><button class="chip folder" data-act="pick-folder">${icon.folder(18)}<span class="lbl">${esc(folder)}</span></button><button class="chip model" data-act="pick-model">${icon.model(18)}<span class="lbl">${esc(modelName(ui.models, ui.draft.model))}</span>${eff}<span class="down">${icon.down(16)}</span></button></div>`;
}

export function composer(placeholder: string, mode: "send" | "stop", value = ""): string {
  const btn = mode === "stop"
    ? `<button class="send stop" data-act="stop" aria-label="${esc(t("composer.stop"))}">${icon.stop(18)}</button>`
    : `<button class="send" data-act="send" aria-label="${esc(t("composer.send"))}" ${value.trim() ? "" : "disabled"}>${icon.send(20)}</button>`;
  return `<div class="composer"><textarea id="input" rows="1" placeholder="${esc(placeholder)}" enterkeyhint="send" autocomplete="off">${esc(value)}</textarea>${btn}</div>`;
}

// ---- session -----------------------------------------------------------------------------------

export function sessionTop(ui: UI, s: SessionSummary | undefined, view: SessionView): string {
  const model = view.model ?? s?.model ?? null;
  const eff = view.effort ?? s?.effort ?? null;
  const state = s?.desktopBridge ? s.state : view.open.length ? "waiting" : view.state ?? s?.state ?? "stopped";
  // A session the host has not made yet (the phone is waiting on its create) has no folder to read.
  const changes = s && !s.id.startsWith("local:")
    ? `<button class="icon-btn" data-act="diff" aria-label="${esc(t("a11y.changes"))}">${icon.file(21)}</button>` : "";
  if (s?.readOnly) return `<button class="icon-btn" data-act="home" aria-label="${esc(t("a11y.back"))}">${icon.back(22)}</button><div class="title"><b>${esc(s.title || folderName(s.cwd, ui.home))}</b><span>${esc(modelName(ui.models, model))}</span></div>${changes}${stateRing("stopped", 24)}`;
  return `<button class="icon-btn" data-act="home" aria-label="${esc(t("a11y.back"))}">${icon.back(22)}</button><div class="title"><b>${esc(s ? s.title || folderName(s.cwd, ui.home) : "")}</b><button data-act="pick-model-session"><span>${esc(modelName(ui.models, model))}${eff ? ` · ${esc(effortLabel(eff))}` : ""}</span>${icon.down(14)}</button></div>${changes}<span class="icon-btn${ui.link.state === "open" ? "" : " stale"}" aria-label="${esc(t(`state.${state}` as Key))}">${stateRing(state, 24)}</span>`;
}

function pct(v: number | null): string {
  return v === null ? `<div class="v na">—</div>` : `<div class="v">${Math.round(v)}%</div>`;
}

export function band(ui: UI, view: SessionView): string {
  const f = view.figures;
  const ctx = f?.contextPct ?? null;
  const five = f?.fiveHourPct ?? null;
  const tone = (v: number | null): string => (v === null ? "" : v >= 85 ? "bad" : v >= 65 ? "warn" : "");
  const bar = (v: number | null): string => `<div class="bar ${tone(v)}"><i style="width:${v === null ? 0 : Math.min(100, Math.max(2, v))}%"></i></div>`;
  const cells = `<div class="cell"><div class="k">${esc(t("band.effort"))}</div>${f?.effort ? `<div class="v">${esc(effortLabel(f.effort))}</div>` : `<div class="v na">—</div>`}</div>` +
    `<div class="cell"><div class="k">${esc(t("band.cache"))}</div>${pct(f?.cachePct ?? null)}</div>` +
    `<div class="cell"><div class="k">${esc(t("band.context"))}</div>${pct(ctx)}${bar(ctx)}</div>` +
    `<div class="cell"><div class="k">${esc(t("band.fiveHour"))}</div>${pct(five)}${bar(five)}</div>`;
  let workers = "";
  if (ui.workersOpen) {
    const list = f?.workers ?? [];
    const rows = list.length
      ? list.map((w) => `<div class="w"><span>${esc(w.model)}</span><span>${esc(t("band.workerLine", { n: w.requests }))}</span></div>`).join("")
      : `<div class="none">${esc(t("band.workersNone"))}</div>`;
    const foot = [f?.fiveHourResetAt ? t("band.resetsAt", { time: clock(f.fiveHourResetAt) }) : "", f ? t("band.updated", { time: clock(f.at) }) : ""].filter(Boolean).join(" · ");
    workers = `<div class="workers"><div class="k" style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:4px">${esc(t("band.workers"))}</div>${rows}${foot ? `<div class="foot">${esc(foot)}</div>` : ""}</div>`;
  }
  return `<button class="band${ui.link.state === "open" ? "" : " stale"}" data-act="workers" aria-expanded="${ui.workersOpen}">${cells}</button>${workers}`;
}

function images(parts?: ImagePart[]): string {
  return (parts ?? []).map(part => part.blob
    ? `<button class="conversation-image" data-act="image" data-blob="${esc(part.blob)}" data-media="${esc(part.mediaType)}" aria-label="${esc(t('image.view'))}"><span>${esc(t('tool.loading'))}</span><img hidden alt="${esc(t('image.view'))}" /></button>`
    : `<div class="image-unavailable">${esc(t('image.unavailable'))}</div>`).join('');
}

function toolRow(tool: ToolView, ui: UI): string {
  const open = ui.expanded.has(tool.id);
  const st = !tool.result ? `<span class="st run">${icon.clock(15)}</span>` : tool.result.ok ? `<span class="st">${icon.check(15)}</span>` : `<span class="st bad">${icon.x(15)}</span>`;
  const row = `<button class="tool" data-act="tool" data-id="${esc(tool.id)}" aria-expanded="${open}">${toolIcon(tool.name)}<span class="nm">${esc(tool.name)}</span><span class="sm">${esc(tool.summary)}</span>${st}</button>`;
  if (!open) return row;
  const fetched = ui.expanded.get(tool.id);
  const body = fetched ?? [tool.input ? textOf(tool.input) : "", tool.result ? textOf(tool.result.text) : ""].filter(Boolean).join("\n\n────\n\n");
  return row + (body ? `<details class="tool-details" data-k="d:${esc(tool.id)}"${ui.expanded.has(`d:${tool.id}`) ? " open" : ""}><summary>${esc(t("perm.showAll"))}</summary><div class="tool-out">${esc(body)}</div></details><div class="tool-preview tool-out">${esc(body.slice(0, 1200).split("\n").slice(0, 12).join("\n"))}${body.length > 1200 || body.split("\n").length > 12 ? "\n…" : ""}</div>` : "") + images(tool.result?.images);
}

export function item(it: TimelineItem, ui: UI): string {
  switch (it.type) {
    case "toolGroup": {
      const open = ui.expanded.has(it.key);
      const summary = activitySummary(it.rows, it.running, lang());
      const label = summary.text + (summary.added || summary.removed ? ` [+${summary.added} −${summary.removed}]` : "") + (summary.failed ? (lang() === "ko" ? " · 실패" : " · Failed") : "");
      return `<div class="tools"><button class="tool" data-act="tool-group" data-id="${esc(it.key)}" aria-expanded="${open}">${it.running ? stateRing("running", 16) : toolIcon("Bash")}<span class="sm">${esc(label)}</span><span style="transform:rotate(${open ? 90 : 0}deg)">${icon.chevron(16)}</span></button>${open ? it.rows.map(row => row.type === "tool" ? toolRow(row.tool, ui) : item(row, ui)).join("") : ""}</div>`;
    }
    case "start":
      return `<div class="start">${esc(t("history.start"))}</div>`;
    case "user": {
      if (it.error !== undefined) {
        // The host refused it: the person's words and the host's own reason stay on screen, and the
        // controls act on the outbox entry the item is keyed by (`u<clientMsgId>`). Retry sends the
        // same id again, which the host acknowledges instead of running twice; the pencil takes the
        // words back into the composer, where a message is changed. A message the app is holding
        // refuses the pencil with its own explanation instead (outbox.waiting).
        const id = it.key.slice(1);
        return `<div class="msg-user failed">${esc(it.text)}${images(it.images)}<div class="q bad">${icon.x(13)}<span>${esc(it.error)}</span></div><div class="q act"><button class="btn ghost" data-act="retry-send" data-id="${esc(id)}">${esc(t("conn.retryNow"))}</button><button class="icon-btn" data-act="edit-send" data-id="${esc(id)}" aria-label="${esc(t("a11y.editMessage"))}">${icon.pencil(16)}</button></div></div>`;
      }
      const q = it.queued ? `<div class="q">${icon.clock(13)}${esc(it.queued === "pending" ? t("queue.pending") : t("queue.sending"))}</div>` : "";
      return `<div class="msg-user${it.queued ? " queued" : ""}">${esc(it.text)}${images(it.images)}${q}</div>`;
    }
    case "thinking":
      // Its own open state lives beside the group's, so a row redrawn while the text streams (or a
      // conversation opened again) does not fold the person's reading shut.
      return `<details class="tool-details" data-k="t:${esc(it.key)}"${ui.expanded.has(`t:${it.key}`) ? " open" : ""}><summary>${icon.clock(15)} ${lang() === "ko" ? "사고 과정" : "Thinking"}</summary><div class="tool-out">${esc(textOf(it.text))}</div></details>`;
    case "assistant": {
      const text = textOf(it.text);
      const caret = it.streaming ? `<span class="caret"></span>` : "";
      const html = text ? markdown(text) : "";
      const withCaret = caret ? (html.endsWith("</p>") ? html.slice(0, -4) + caret + "</p>" : html + caret) : html;
      const tools = it.tools.length ? `<div class="tools">${it.tools.map((tl) => toolRow(tl, ui)).join("")}</div>` : "";
      // Copy is offered while the answer streams too: the words are already readable, and the
      // browser's own selection keeps working across blocks (patchList carries it over a delta).
      const copy = text.trim()
        ? `<div class="msg-acts"><button class="msg-copy" data-act="copy-answer" data-key="${esc(it.key)}" aria-label="${esc(t("answer.copy"))}">${icon.copy(16)}${esc(t("answer.copyShort"))}</button></div>`
        : "";
      return `<div class="msg-asst">${withCaret}${images(it.images)}${tools}${copy}</div>`;
    }
    case "subagent": {
      const st = t(`sub.${it.status}`);
      return `<button class="sub" data-act="sub" data-id="${esc(it.sub)}">${stateRing(it.status === "running" ? "running" : it.status === "done" ? "idle" : it.status === "stopped" ? "stopped" : "error", 28)}<div class="body"><div class="k">${esc(t("sub.worker"))}${it.model ? `<span class="model">${esc(it.model)}</span>` : ""}<span>· ${esc(st)} · ${esc(t("sub.steps", { n: it.steps }))}</span></div><div class="d">${esc(it.description)}</div></div>${icon.chevron(18)}</button>`;
    }
    case "permission": {
      if (it.decision === null) return `<div class="perm-done open">${icon.shield(16)}<span class="nm">${esc(it.tool)}</span><span class="sm">${esc(it.summary)}</span><span>${esc(t("state.waiting"))}</span></div>`;
      const label = it.decision === "allow" ? t("perm.allowed") : it.decision === "allow_always" ? t("perm.allowedAlways") : it.decision === "deny" ? t("perm.denied") : t("perm.expired");
      const cls = it.decision === "allow_always" ? "allow" : it.decision;
      if (it.requestKind === "plan") {
        const open = ui.expanded.has(it.id);
        const body = ui.expanded.get(it.id) ?? textOf(it.input);
        return `<div><div class="perm-done ${cls}"><button class="tool" data-act="tool" data-id="${esc(it.id)}" aria-expanded="${open}"><span class="nm">${esc(it.title || it.tool)}</span><span>${esc(label)}</span>${icon.chevron(16)}</button></div>${open ? `<div class="msg-asst">${markdown(body)}${it.decision === "expired" && it.reason ? `<div class="foot">${esc(t(`perm.reason.${it.reason}` as Key, { host: hostName(ui) }))}</div>` : ""}</div>` : ""}</div>`;
      }
      const why = it.decision === "expired" && it.reason ? `<span class="why">${esc(t(`perm.reason.${it.reason}` as Key, { host: hostName(ui) }))}</span>` : "";
      return `<div class="perm-done ${cls}">${it.decision === "allow" || it.decision === "allow_always" ? icon.check(16) : icon.x(16)}<span class="nm">${esc(it.tool)}</span><span class="sm">${esc(it.summary)}</span><span>${esc(label)}</span></div>${why ? `<div class="foot">${why}</div>` : ""}`;
    }
    case "result": {
      const turn = it.turn === undefined ? "" : `${t("turn.number", { n: it.turn })} · `;
      if (!it.ok) return `<div class="foot bad">${icon.x(14)}${esc(turn + t("turn.failed", { error: it.error ?? "" }))}</div>`;
      return `<div class="foot">${esc(turn + t("turn.footer", { model: modelName(ui.models, it.model), effort: effortLabel(it.effort) || "—", dur: duration(it.ms) }))}</div>`;
    }
    case "control": {
      // A session command drawn as the state of what it asked for; it is never a button, because
      // undoing files or turns is designed apart from this display.
      const state = it.state === "running" ? icon.clock(15) : it.state === "done" ? icon.check(15) : icon.x(15);
      return `<div class="notice control ${it.state}">${state}${esc(t(`control.${it.command}.${it.state}` as Key))}</div>`;
    }
    case "notice":
      return `<div class="notice">${esc(t(`notice.${it.code}` as Key, { text: it.text ?? "", host: hostName(ui) }))}</div>`;
    case "chapter":
      return `<div class="start" title="${esc(it.summary)}">${esc(it.title)}</div>`;
    case "wrapUp":
      return `<div class="msg-asst">${it.recap ? `<p>${esc(it.recap)}</p>` : ""}${it.ask ? `<p><strong>${esc(it.ask)}</strong></p>` : ""}</div>`;
  }
}

/** The open permission request, docked above the composer where the thumb already is. */
export function permCard(view: SessionView, ui: UI): string {
  const p = view.open[0];
  if (!p) return "";
  if (p.requestKind === "question") return questionCard(p, ui);
  const open = ui.permOpen.has(p.id);
  const what = textOf(p.input) || p.summary;
  const long = what.split("\n").length > 5 || what.length > 280;
  return `<div class="perm" role="alertdialog" aria-label="${esc(t("perm.title", { tool: p.tool }))}"><div class="hd">${icon.shield(16)}<span>${esc(p.tool)}</span>${view.open.length > 1 ? `<span class="of">${esc(t("perm.of", { i: 1, n: view.open.length }))}</span>` : ""}</div><div class="q">${esc(p.title || t("perm.title", { tool: p.tool }))}</div><div class="what${open ? " open" : ""}">${esc(what)}</div>${long && !open ? `<button class="more" data-act="perm-more" data-id="${esc(p.id)}">${esc(t("perm.showAll"))}</button>` : ""}<div class="act"><button class="deny" data-act="deny" data-id="${esc(p.id)}">${esc(t("perm.deny"))}</button><button class="allow" data-act="allow" data-id="${esc(p.id)}">${icon.check(20)}${esc(t("perm.allow"))}</button></div>${p.canAlways ? `<button class="always" data-act="always" data-id="${esc(p.id)}">${esc(t("perm.always"))}</button>` : ""}</div>`;
}

function questionCard(p: Extract<TimelineItem, { type: "permission" }>, ui: UI): string {
  const questions = p.questions ?? [], draft = ui.questionDrafts?.get(p.id) ?? emptyQuestionDraft();
  const index = Math.max(0, Math.min(draft.current, questions.length - 1));
  const question = questions[index], answers = questionAnswers(questions, draft), busy = ui.deciding?.has(p.id) ?? false;
  const tabs = questions.length > 1 ? `<div class="act">${questions.map((q, i) => `<button class="btn ghost" data-act="question-jump" data-id="${esc(p.id)}" data-index="${i}" aria-current="${i === index ? "step" : "false"}" ${busy ? "disabled" : ""}>${esc(q.header || q.question)}<br><span id="question-preview-${esc(p.id)}-${i}">${esc(answers[q.question] || t("perm.unanswered"))}</span></button>`).join("")}</div>` : "";
  const choices = question ? `<div class="q">${esc(question.question)}</div><div class="list"${question.multiSelect ? "" : ' role="radiogroup"'}>${question.options.map((option, i) => `<button class="opt" data-act="question-option" data-id="${esc(p.id)}" data-index="${index}" data-option="${i}" role="${question.multiSelect ? "checkbox" : "radio"}" aria-checked="${draft.selected[question.question]?.includes(option.label) ?? false}" ${busy ? "disabled" : ""}><div class="body"><div class="t1">${esc(option.label)}</div><div class="t2" style="white-space:pre-wrap">${esc(option.description)}</div></div></button>`).join("")}</div><textarea id="question-free-${esc(p.id)}-${index}" data-question-free="true" data-id="${esc(p.id)}" data-index="${index}" rows="2" placeholder="${esc(t("perm.customAnswer"))}" aria-label="${esc(t("perm.customAnswer"))}" ${busy ? "disabled" : ""}>${esc(draft.free[question.question] ?? "")}</textarea>` : "";
  return `<div class="perm" role="group" aria-label="${esc(p.title || p.tool)}"><div class="hd">${esc(p.title || p.tool)} <span>${esc(t("perm.of", { i: question ? index + 1 : 0, n: questions.length }))}</span></div>${tabs}${choices}<div class="act"><button class="deny" data-act="deny" data-id="${esc(p.id)}" ${busy ? "disabled" : ""}>${esc(t("perm.deny"))}</button><button class="allow" data-act="allow" data-id="${esc(p.id)}" ${busy || !questionsComplete(questions, draft) ? "disabled" : ""}>${esc(busy ? t("queue.sending") : t("perm.submitAnswers"))}</button></div></div>`;
}

export function workingLine(view: SessionView, ui: UI, s?: SessionSummary): string {
  if (!(view.state === "running" || view.state === "starting") || view.open.length) return "";
  // Disconnected, a ticking "working for" would claim knowledge we do not have: say when it was last seen working.
  if (ui.link.state !== "open") return `<div class="working stale">${icon.clock(16)}<span>${esc(t("running.lastSeen", { time: clock(ui.link.lastRx ?? ui.now) }))}</span></div>`;
  const since = s?.turnStartedAt ?? view.turnStartedAt ?? ui.now;
  return `<div class="working">${stateRing("running", 16)}<span>${esc(t("running.for", { t: duration(ui.now - since) }))}</span></div>`;
}

/** The same confirmed task snapshot used by mobile, including completed tasks after the turn. */
export function plan(s: SessionSummary | undefined, open: boolean): string {
  const steps = s?.plan ?? [];
  if (!steps.length) return "";
  const done = steps.filter(step => step.status === "completed").length;
  const current = steps.find(step => step.status === "in_progress") ?? steps.find(step => step.status === "pending");
  const rows = open ? `<div class="tasks-list" role="list" aria-label="${esc(t("plan.title"))}">${steps.map(step => `<div class="task" role="listitem"><span>${esc(t(`plan.${step.status}`))}</span><span style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(step.text)}</span></div>`).join("")}</div>` : "";
  return `${rows}<button class="tasks-chip" data-act="plan-toggle" aria-expanded="${open}">${esc(t("plan.title"))} ${done}/${steps.length}${current ? ` · ${esc(current.text)}` : ""}${open ? icon.down(14) : icon.chevron(14)}</button>`;
}

/** The background-task chip; with a task list from the host it opens to show what is running. */
export function tasks(ui: UI, s: SessionSummary | undefined, open: boolean, items: TimelineItem[] = [], seen: ReadonlySet<string> = new Set()): string {
  const { active, recent, counts } = activityOverview(items, s?.taskList, s?.taskHistory);
  counts.unknown += Math.max(0, (s?.tasks ?? 0) - (s?.taskList?.length ?? 0));
  if (!active.length && !recent.length && !counts.unknown && s?.backgroundKnown) return "";
  const unread = recent.filter(task => task.state === "failed" && !seen.has(task.sub ?? task.id)).length;
  const note = !s?.backgroundKnown ? `<div class="foot">${esc(t("tasks.visibility"))}</div>` : "";
  const rows = open ? `<div class="tasks-list">${[...active, ...recent].map(task => {
    const state = t(activityStateKey(task));
    return `<button class="tool" data-act="task-read" data-id="${esc(task.sub ?? task.id)}"${task.sub ? ` data-sub="${esc(task.sub)}"` : ""}><span class="nm">${esc(t(`tasks.kind.${task.kind}`))} · ${esc(state)}</span><span style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(task.label)}${task.command && task.command !== task.label ? `<br>${esc(task.command)}` : ""}${task.schedule ? `<br>${esc(task.schedule)}` : ""}${task.nextAt === undefined ? "" : `<br>${esc(clock(task.nextAt))}`}</span></button>`;
  }).join("")}${note}${s?.activityAt == null ? "" : `<div class="foot">${esc(t("band.updated", { time: clock(s.activityAt) }))}</div>`}</div>` : "";
  const chip = `${esc(t("tasks.summary", counts))}${unread ? ` · ${esc(t("tasks.unread", { n: unread }))}` : ""}${!s?.backgroundKnown ? ` · ${esc(t("tasks.unknown"))}` : ""}`;
  return `${rows}<button class="tasks-chip${unread ? " bad" : ""}" data-act="toggle-tasks" aria-expanded="${open}">${chip}${open ? icon.down(14) : icon.chevron(14)}</button>`;
}

// ---- changes -----------------------------------------------------------------------------------

/** A patch's own lines, git's headers left out; a hunk keeps its `@@` so a change's place is visible. */
export function patchLines(patch: string): string[] {
  const lines = patch.split("\n").filter(line => !/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) |old mode |new mode )/.test(line));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The +/− capsule a changed file ends with, as the app draws it. */
function countsPill(added: number, removed: number): string {
  if (added <= 0 && removed <= 0) return "";
  const add = added > 0 ? `<span class="add">+${added}</span>` : "";
  const del = removed > 0 ? `<span class="del">−${removed}</span>` : "";
  return `<span class="counts" aria-label="${esc(t("diff.counts", { added, removed }))}">${add}${del}</span>`;
}

/**
 * The session folder's changes: a scope switch (when the host offers one), the files, and one file's
 * whole patch over that list. The list is drawn again from `scroll`, so a person comes back from a
 * file where they were, and a file opens where it was last read (the app holds that offset).
 */
function diffSheet(ui: UI, s: Extract<Sheet, { kind: "diff" }>): string {
  const head = `<div class="grab"></div><div class="sh"><b>${esc(t("diff.title"))}</b><button class="icon-btn" data-act="close-sheet" aria-label="${esc(t("a11y.close"))}">${icon.x(20)}</button></div>`;
  const frame = (body: string): string => `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(t("diff.title"))}">${head}<div class="sbody" id="diff-body">${body}</div></div>`;
  if (s.error) {
    const message = /not a git repository/.test(s.error) ? t("diff.notGit") : s.error;
    return frame(`<div class="note bad" role="alert">${esc(message)}</div><div class="dfoot"><button class="btn ghost" data-act="diff-retry">${esc(t("conn.retryNow"))}</button></div>`);
  }
  const view = s.view;
  if (!view) return frame(`<div class="note" role="status">${esc(t("tool.loading"))}</div>`);
  const file = s.open === null ? undefined : view.files.find(entry => entry.path === s.open);
  if (file) {
    const index = view.files.indexOf(file);
    const lines = patchLines(file.patch);
    const name = file.path.split("/").at(-1) ?? file.path;
    // Walking the change lands on files that can be read: a binary beside them has no patch.
    const reachable = (from: number, delta: number): number | null => {
      for (let at = from + delta; at >= 0 && at < view.files.length; at += delta) if (view.files[at]?.patch) return at;
      return null;
    };
    const prev = reachable(index, -1), next = reachable(index, 1);
    const step = (target: number | null, label: string, glyph: string): string =>
      target === null
        ? `<button class="icon-btn" aria-label="${esc(label)}" disabled>${glyph}</button>`
        : `<button class="icon-btn" data-act="diff-step" data-index="${target}" aria-label="${esc(label)}">${glyph}</button>`;
    const where = `${file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} · ${t("perm.of", { i: index + 1, n: view.files.length })}`;
    const drawn = lines.map(line => {
      const hunk = line.startsWith("@@"), add = !hunk && line.startsWith("+"), del = !hunk && line.startsWith("-");
      return `<div class="ln${add ? " add" : del ? " del" : hunk ? " hunk" : ""}"><span class="mk">${add ? "+" : del ? "−" : " "}</span><span class="tx">${esc(hunk ? line : line.slice(1))}</span></div>`;
    }).join("");
    return frame(`<div class="diff-head"><button class="btn ghost" data-act="diff-back" aria-label="${esc(t("diff.back"))}">${icon.back(18)}<span>${esc(t("diff.back"))}</span></button><div class="body"><div class="t1">${esc(name)}</div><div class="t2">${esc(where)}</div></div>${countsPill(file.added, file.removed)}${step(prev, t("diff.prev"), icon.up(18))}${step(next, t("diff.next"), icon.down(18))}${file.patch ? `<button class="btn ghost" data-act="diff-copy" data-id="${esc(file.path)}">${esc(t("diff.copyShort"))}</button>` : ""}</div><div class="patch">${drawn}</div>${lines.length ? "" : `<div class="note">${esc(t("diff.empty"))}</div>`}${file.cut ? `<div class="note">${esc(t("diff.cut"))}</div>` : ""}`);
  }
  const options = ui.host?.capabilities?.diffScope === true
    ? `<div class="seg diff-scope" role="radiogroup" aria-label="${esc(t("diff.title"))}">${([["uncommitted", t("diff.scope.uncommitted")], ["branch", t("diff.scope.branch")]] as const).map(([scope, label]) => {
      const on = s.scope === "auto" ? (view.scope === "branch" ? "branch" : "uncommitted") === scope : s.scope === scope;
      return `<button role="radio" aria-checked="${on}" class="${on ? "on" : ""}" data-act="diff-scope" data-scope="${scope}">${esc(label)}</button>`;
    }).join("")}</div>` : "";
  const where = view.scope === "branch" && view.base ? t("diff.base", { base: view.base })
    : view.scope === "uncommitted" ? t("diff.uncommitted") : t("diff.clean");
  const rows = view.files.map(file => {
    const name = file.path.split("/").at(-1) ?? file.path;
    const folder = file.path.slice(0, Math.max(0, file.path.length - name.length - 1));
    const sub = [t(`diff.status.${file.status}` as Key), file.oldPath ? `← ${file.oldPath}` : folder, file.cut ? t("diff.partial") : ""].filter(Boolean).join(" · ");
    const body = `${icon.file(20)}<div class="body"><div class="t1">${esc(name)}</div><div class="t2">${esc(sub)}</div></div>${countsPill(file.added, file.removed)}`;
    // A binary has no patch, so its row is a fact, not a way in.
    return file.patch
      ? `<button class="diff-file" data-act="diff-file" data-id="${esc(file.path)}" aria-label="${esc(`${file.path}, ${t(`diff.status.${file.status}` as Key)}`)}">${body}${icon.chevron(18)}</button>`
      : `<div class="diff-file">${body}</div>`;
  }).join("");
  const empty = view.files.length ? "" : `<div class="note">${esc(s.scope === "branch" ? t("diff.cleanBranch") : s.scope === "uncommitted" ? t("diff.cleanUncommitted") : t("diff.clean"))}</div>`;
  const summary = view.files.length
    ? `<div class="diff-sum"><span>${esc(view.branch ? t("diff.branch", { branch: view.branch }) : t("diff.noBranch"))}</span><span class="sep">·</span><span>${esc(where)}</span><span class="sep">·</span><span>${esc(t("diff.files", { n: view.files.length }))}</span></div>`
    : `<div class="diff-sum"><span>${esc(where)}</span></div>`;
  return frame(`${options}${summary}${rows}${empty}${view.truncated ? `<div class="note">${esc(t("diff.truncated"))}</div>` : ""}`);
}

// ---- sheets ------------------------------------------------------------------------------------

export function sheet(ui: UI): string {
  const s = ui.sheet;
  if (!s) return "";
  const head = (title: string): string => `<div class="grab"></div><div class="sh"><b>${esc(title)}</b><button class="icon-btn" data-act="close-sheet" aria-label="${esc(t("a11y.close"))}">${icon.x(20)}</button></div>`;
  if (s.kind === "diff") return diffSheet(ui, s);
  if (s.kind === "worker") {
    const worker = s.worker;
    const facts = [worker.model, t(`sub.${worker.status}`), t("sub.steps", { n: worker.steps })].filter(Boolean).join(" · ");
    const back = s.depth > 1 ? `<button class="icon-btn" data-act="worker-back" aria-label="${esc(t("a11y.back"))}">${icon.back(20)}</button>` : "";
    const body = s.items.map(child => item(child, { ...ui, expanded: s.expanded })).join("");
    const error = s.error ? `<div class="foot bad" role="alert">${esc(s.error)}</div><button class="btn ghost" data-act="worker-retry">${esc(t("conn.retryNow"))}</button>` : "";
    return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(worker.description || t("sub.worker"))}"><div class="grab"></div><div class="sh">${back}<b>${esc(worker.description || t("sub.worker"))}</b><button class="icon-btn" data-act="close-sheet" aria-label="${esc(t("a11y.close"))}">${icon.x(20)}</button></div><div class="sbody" id="worker-body" data-sub="${esc(worker.sub)}"><div class="foot">${esc(facts)}</div>${error}<div class="tl">${body}</div>${s.loading ? `<div role="status" class="foot">${esc(t("tool.loading"))}</div>` : ""}</div></div>`;
  }
  if (s.kind === "folder") {
    const f = s.filter.trim().toLowerCase();
    const recent = s.recent.filter((r) => !f || r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f)).slice(0, 6);
    const recentHtml = recent.length
      ? `<div class="sec">${esc(t("folder.recent"))}</div><div class="list">${recent.map((r) => `<button class="opt${ui.draft.cwd === r.path ? " on" : ""}" data-act="choose-folder" data-path="${esc(r.path)}">${icon.folder(20)}<div class="body"><div class="t1">${esc(r.name)}</div><div class="t2">${esc(shortPath(r.path, ui.home))}${r.lastUsed ? ` · ${esc(relTime(r.lastUsed, ui.now))}` : ""}</div></div>${ui.draft.cwd === r.path ? `<span class="tick">${icon.check(20)}</span>` : ""}</button>`).join("")}</div>`
      : "";
    let browse = "";
    if (s.browse) {
      const b = s.browse;
      const rel = shortPath(b.path, b.home);
      const parts = rel.split("/").filter(Boolean);
      const crumbs = parts.map((p, i) => {
        const full = rel.startsWith("~") ? b.home + "/" + parts.slice(1, i + 1).join("/") : "/" + parts.slice(0, i + 1).join("/");
        return `${i ? `<span class="sl">/</span>` : ""}<button data-act="browse" data-path="${esc(i === 0 && rel.startsWith("~") ? b.home : full.replace(/\/$/, ""))}">${esc(p)}</button>`;
      }).join("");
      const entries = b.entries.filter((e) => isDrivePath(e.path) || !f || e.name.toLowerCase().includes(f));
      browse = `<div class="sec">${esc(t("folder.browse"))}</div><div class="crumbs">${crumbs}</div><div class="list">${b.parent ? `<button class="opt" data-act="browse" data-path="${esc(b.parent)}">${icon.up(20)}<div class="body"><div class="t1">${esc(t("folder.up"))}</div></div></button>` : ""}${entries.map((e) => `<button class="opt" data-act="browse" data-path="${esc(e.path)}">${isDrivePath(e.path) ? icon.disk(20) : icon.folder(20)}<div class="body"><div class="t1">${esc(e.name)}</div></div>${icon.chevron(18)}</button>`).join("") || `<div class="opt"><div class="body"><div class="t2">${esc(t("folder.empty"))}</div></div></div>`}</div>${b.truncated ? `<div class="sec">${esc(t("folder.truncated", { n: b.entries.length }))}</div>` : ""}`;
    }
    const target = s.browse?.path ?? ui.draft.cwd;
    // A path can be typed as well as browsed to: on Windows another drive is otherwise a walk up to
    // the root, and a folder nobody visited is not in "recent" either (Discord, 2026-10-25). The
    // host checks the path — a missing one comes back as an error, not an empty list.
    const pathbar = `<div class="pathbar">${icon.terminal(18)}<input id="folder-path" value="${esc(s.pathDraft ?? target ?? "")}" placeholder="${esc(t("folder.path"))}" aria-label="${esc(t("folder.path"))}" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go"><button data-act="browse-path">${esc(t("folder.go"))}</button></div>`;
    const foot = target ? `<div class="sfoot"><div class="path">${esc(shortPath(target, ui.home))}</div><button class="btn primary" data-act="choose-folder" data-path="${esc(target)}">${esc(t("folder.here"))}</button></div>` : "";
    return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog">${head(t("folder.title"))}${pathbar}<div class="filter">${icon.search(18)}<input id="folder-filter" placeholder="${esc(t("folder.filter"))}" value="${esc(s.filter)}" autocomplete="off"></div><div class="sbody">${recentHtml}${browse}</div>${foot}</div>`;
  }
  if (s.kind === "session") {
    // One session's own actions, in the order people reach for them: keep it out of the list, pin
    // it where it can be found, put the unread mark back. The row's ⋯ opens this, so every action
    // here also has a menu beside it rather than a gesture only.
    const session = ui.sessions.find(x => x.id === s.id);
    if (!session) return "";
    const live = ui.link.state === "open";
    const pinned = isPinned(session, ui.pins);
    // A Desktop star is the Desktop app's to remove; this phone cannot take it back, so it is not offered.
    const canPin = pinned || session.group !== PINNED_GROUP;
    const flagged = sidebarState(session) === "unread";
    const opt = (act: string, label: string): string => `<button class="opt" data-act="${act}" data-id="${esc(session.id)}" ${live ? "" : "disabled"}><div class="body"><div class="t1">${esc(label)}</div></div></button>`;
    const note = live ? folderName(session.cwd, ui.home) : t("home.needsHost");
    return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(t("a11y.sessionMenu"))}">${head(sessionTitle(session))}<div class="sbody"><div class="list">${opt("archive-toggle", session.archived ? t("home.unarchive") : t("home.archive"))}${canPin ? opt("pin-toggle", pinned ? t("home.unpin") : t("home.pin")) : ""}${flagged ? "" : opt("unread", t("home.markUnread"))}</div><div class="note">${esc(note)}</div></div><div class="sfoot"><button class="btn primary" data-act="close-sheet">${esc(t("a11y.close"))}</button></div></div>`;
  }
  if (s.kind === "recovery") {
    // Everything the person can read or copy of what was saved for another connection (or an
    // earlier pairing of this one), plus what this computer is already holding after an import.
    // Nothing here goes out on its own: checkboxes choose copies, and the copies wait.
    if (s.unavailable) {
      return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog">${head(t("recovery.title"))}<div class="sbody"><div class="note">${esc(t("outbox.storageUnavailable"))}</div></div><div class="sfoot"><button class="btn primary" data-act="close-sheet">${esc(t("a11y.close"))}</button></div></div>`;
    }
    const row = (entry: OutboxEntry, why: string, acts: string): string =>
      `<div class="opt kept full"><div class="body"><div class="t1">${esc(entry.text)}</div><div class="t2">${esc(why)}</div></div><div class="acts">${acts}</div></div>`;
    const copyButton = (id: string): string => `<button class="btn ghost" data-act="recovery-copy" data-id="${esc(id)}">${esc(t("recovery.copy"))}</button>`;
    const held = s.held.map((entry) => row(entry,
      entry.hold === "unknown_outcome" ? t("outbox.unknown") : t("outbox.waiting"),
      `<button class="btn ghost" data-act="retry-send" data-id="${esc(entry.clientMsgId)}">${esc(t("conn.retryNow"))}</button>${copyButton(entry.clientMsgId)}`)).join("");
    const recovered = s.recovered.map((entry) => row(entry, t("recovery.noAutomaticSend"),
      (entry.create ? `<button class="btn ghost" data-act="recovery-send" data-id="${esc(entry.clientMsgId)}">${esc(t("composer.send"))}</button>` : "") + copyButton(entry.clientMsgId))).join("");
    const pick = (item: PreservedItem): string => {
      const on = s.picked.has(item.key);
      return `<div class="kept full"><button class="opt full${on ? " on" : ""}" data-act="recovery-pick" data-id="${esc(item.key)}" aria-pressed="${on}"><div class="body"><div class="t1">${esc(item.entry.text)}</div><div class="t2">${esc(relTime(item.entry.at, ui.now))}</div></div>${on ? `<span class="tick">${icon.check(20)}</span>` : ""}</button><div class="acts">${copyButton(item.key)}</div></div>`;
    };
    const unreadable = s.raw.map((raw, index) => `<div class="opt kept full"><div class="body"><div class="t1">${esc(t("outbox.unreadable"))}</div>${s.shown === index ? `<pre class="raw">${esc(raw)}</pre>` : ""}</div><div class="acts"><button class="btn ghost" data-act="recovery-raw" data-id="${index}">${esc(t("recovery.raw"))}</button>${copyButton(`raw:${index}`)}</div></div>`).join("");
    // The host name in the confirmation is the one the phone knows; esc() keeps it text, never markup.
    const foot = s.step === "confirm"
      ? `<div class="note">${esc(t("recovery.confirm", { host: hostName(ui) }))}</div><div class="note">${esc(t("recovery.noAutomaticSend"))}</div><button class="btn primary" data-act="recovery-import">${esc(t("recovery.import"))}</button>`
      : `<button class="btn primary" data-act="recovery-import" ${s.picked.size ? "" : "disabled"}>${esc(t("recovery.import"))}</button>`;
    return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog">${head(t("recovery.title"))}<div class="sbody"><div class="note">${esc(t("recovery.body"))}</div>${held}${recovered}${s.candidates.map(pick).join("")}${unreadable}</div><div class="sfoot">${foot}</div></div>`;
  }
  const chosen = s.groups.flatMap((g) => g.models).find((m) => m.model === s.model);
  const recentIds = s.recent.filter((id) => s.groups.some((g) => g.models.some((m) => m.model === id && m.usable))).slice(0, 3);
  const opt = (m: { model: string; name: string; usable: boolean }, sub: string): string =>
    `<button class="opt${s.model === m.model ? " on" : ""}" data-act="choose-model" data-model="${esc(m.model)}" ${m.usable ? "" : "disabled"}>${icon.model(20)}<div class="body"><div class="t1">${esc(m.name)}</div><div class="t2 mono">${esc(sub)}</div></div>${s.model === m.model ? `<span class="tick">${icon.check(20)}</span>` : m.usable ? "" : `<span class="badge">${esc(t("model.unusable"))}</span>`}</button>`;
  const recentHtml = recentIds.length
    ? `<div class="sec">${esc(t("model.recent"))}</div><div class="list">${recentIds.map((id) => { const m = s.groups.flatMap((g) => g.models.map((x) => ({ ...x, label: g.label }))).find((x) => x.model === id)!; return opt(m, `${m.label} · ${m.model}`); }).join("")}</div>`
    : "";
  const groups = s.groups.map((g) => `<div class="sec">${esc(g.label)}${g.usable ? "" : ` · ${esc(t("model.unusable"))}`}</div><div class="list">${g.models.map((m) => opt(m, m.model)).join("")}</div>`).join("");
  const efforts = chosen?.efforts ?? [];
  // Auto is the mod's host-wide setting, so it only exists where the host can write it and the
  // chosen model has levels for it to choose between. It comes first, like the dashboard's toggle.
  const autoShown = efforts.length > 0 && ui.host?.capabilities?.effortAuto === true && !!ui.host.ripple;
  const autoOn = autoShown && s.auto === true;
  const seg = efforts.length
    ? `<div class="seg-label"><span>${esc(t("model.effort"))}</span></div><div class="seg">${autoShown ? `<button class="${autoOn ? "on" : ""}" data-act="choose-auto">${esc(t("model.auto"))}</button>` : ""}${efforts.map((e) => `<button class="${!autoOn && s.effort === e ? "on" : ""}" data-act="choose-effort" data-effort="${e}">${esc(effortLabel(e))}</button>`).join("")}</div>${autoShown ? `<div class="note">${esc(t("model.autoHint"))}</div>` : ""}`
    : `<div class="seg-label"><span>${esc(t("model.noEffort"))}</span></div>`;
  return `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog">${head(t("model.title"))}<div class="sbody">${recentHtml}${groups}</div><div class="sfoot">${seg}<div style="height:10px"></div><button class="btn primary" data-act="model-done" ${s.model ? "" : "disabled"}>${esc(t("model.done"))}</button></div></div>`;
}

// ---- pairing -----------------------------------------------------------------------------------

export function pairScreen(): string {
  return `<div class="pair">${ripple("calm", 96)}<h1>${esc(t("pair.title"))}</h1><ol><li><div>${esc(t("pair.step1"))}<code>${esc(t("pair.where"))}</code></div></li><li><div>${esc(t("pair.step2"))}</div></li><li><div>${esc(t("pair.step3"))}</div></li></ol><div class="paste"><label for="pair-link">${esc(t("pair.paste"))}</label><div class="row"><input id="pair-link" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…#pair=…"><button class="btn primary" data-act="pair-link">${esc(t("pair.connect"))}</button></div></div><div class="note">${esc(t("pair.note"))}</div></div>`;
}
