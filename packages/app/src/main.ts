// ClaudeRipple menu-bar app. It owns no logic: the router serves the GUI and the admin API on
// 127.0.0.1; this shell adds a tray icon with live health, a window for the GUI, and shortcuts
// for restart / logs / login. If the router is down the tray says so and offers to start it.

import { app, Menu, Tray, Notification, nativeImage, shell, dialog, clipboard } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Status = {
  version: string;
  /** Reported from 0.1.2 on; an older router leaves it out. */
  runtime?: { node: string; router: string | null; startedAt: string };
  /** Reported from 0.1.2 on: whether requests can actually go through, and what is in the way. */
  readiness?: { ready: boolean; problems: ("settings" | "upstream" | "picker-ca" | "picker-proxy" | `provider:${string}`)[] };
  listen: { host: string; port: number };
  adminPort: number;
  stats: { started: number; completed: number; failed: number; inFlight: number };
  consecutiveUpstreamFailures: number;
  routes: number;
  providers: Record<string, { url?: string; reachable: boolean; type?: string }>;
  settings: { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string };
  cliVersion: string;
  chatgpt?: { quota: Record<string, Record<string, unknown> | null>; auth: Record<string, string>; signedIn?: Record<string, boolean> };
  picker?: { enabled: boolean; hosts: string[]; last: unknown };
  agentTitle?: boolean;
};

const home = process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple");
const POLL_MS = 5000;

// ---- i18n: tray menu, dialogs, tooltips -------------------------------------------------

const STRINGS = {
  en: {
    healthy: "healthy",
    attentionNeeded: "attention needed",
    routerNotRunning: "router not running",
    slotsMapped: (n: number) => `${n} slot${n === 1 ? "" : "s"} mapped`,
    inFlight: "in flight",
    connected: "Claude Desktop connected",
    notConnected: "Claude Desktop not connected",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan} ${percent}% this week`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "Restart Router",
    startRouter: "Start Router",
    pickerOn: "Show GPT models in the Code tab picker…",
    pickerOff: "Stop showing GPT models in the picker…",
    pickerState: (on: boolean): string => (on ? "Picker: GPT models shown by name ✓" : "Picker: GPT models via Claude names (alias mode)"),
    pickerOnConfirm: "macOS will ask for your login password to trust the ClaudeRipple certificate (ClaudeRipple never sees it). Then quit and reopen Claude Desktop.",
    pickerDone: "Done. Now quit Claude Desktop completely and open it again, then check the Code tab picker.",
    pickerOffDone: "Done. Quit and reopen Claude Desktop to apply.",
    cancel: "Cancel",
    agentTitleOn: "Show model names on subagents",
    agentTitleOff: "Stop showing model names on subagents",
    agentTitleDone: (on: boolean): string => (on ? "On. New subagents will be titled like \"Terra·high · …\"." : "Off."),
    signInChatgpt: "Sign in to ChatGPT…",
    connectClaudeSubscription: "Connect Claude subscription…",
    copyStatus: "Copy Status",
    showLogs: "Show Logs",
    rerunSetup: "Run ClaudeRipple setup again…",
    setupTitle: "Set up ClaudeRipple",
    setupPrompt: "ClaudeRipple will create a local certificate, connect Claude Code settings (~/.claude/settings.json), and register the background router. Continue?",
    setupLater: "Later",
    setupContinue: "Continue",
    setupDone: "ClaudeRipple setup finished.",
    setupFailed: "Setup did not finish",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `The running router is ${from}. Switching it to this version…`,
    updatedFailed: "The router could not be switched to this version",
    problem: (code: string) =>
      code === "settings" ? "Claude Code is not pointed at ClaudeRipple"
      : code === "upstream" ? "Anthropic is unreachable"
      : code === "picker-ca" ? "picker mode: certificate not trusted"
      : code === "picker-proxy" ? "picker mode: Claude Desktop proxy not set"
      : code.startsWith("provider:") ? `provider ${code.slice(9)} unreachable`
      : code,
    about: "About ClaudeRipple",
    aboutDetail:
      "Run GPT and other models inside Claude Desktop, without turning Claude off.\n\nIndependent open-source project (GPL-3.0). Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC.",
    quit: "Quit",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: router not running — Claude Desktop cannot connect",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "Start at login",
    downNotifyTitle: "Claude Desktop cannot connect",
    downNotifyBody: "The ClaudeRipple router is not running, so Claude Desktop has no way out. Click to start it.",
    starting: "starting the router…",
    openDashboard: "Open Dashboard in Browser…",
    offlineHeading: "The router is not running",
    offlineBody:
      "Claude Desktop sends all of its traffic through ClaudeRipple, so while the router is down the app shows a blank window with ERR_PROXY_CONNECTION_FAILED. Start the router and reload Claude Desktop.",
    setupNeeded: "setup not finished",
    setupNeededDetail: "ClaudeRipple is installed but not set up yet",
    runSetup: "Finish setting up ClaudeRipple…",
  },
  ko: {
    healthy: "정상",
    attentionNeeded: "확인 필요",
    routerNotRunning: "라우터가 꺼져 있음",
    slotsMapped: (n: number) => `슬롯 ${n}개 매핑`,
    inFlight: "진행 중",
    connected: "Claude Desktop 연결됨",
    notConnected: "Claude Desktop 연결 안 됨",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan} 주간 ${percent}%`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "라우터 재시작",
    startRouter: "라우터 시작",
    pickerOn: "Code 탭 피커에 GPT 모델 이름 표시…",
    pickerOff: "피커의 GPT 모델 표시 끄기…",
    pickerState: (on: boolean): string => (on ? "피커: GPT 모델을 실명으로 표시 중 ✓" : "피커: Claude 이름으로 GPT 사용(별칭 모드)"),
    pickerOnConfirm: "ClaudeRipple 인증서를 신뢰하기 위해 macOS가 로그인 암호를 묻습니다(ClaudeRipple은 암호를 보지 않습니다). 끝나면 Claude Desktop을 완전히 종료했다가 다시 여세요.",
    pickerDone: "완료. 이제 Claude Desktop을 완전히 종료한 뒤 다시 열고 Code 탭 피커를 확인하세요.",
    pickerOffDone: "완료. Claude Desktop을 종료했다가 다시 열면 적용됩니다.",
    cancel: "취소",
    agentTitleOn: "서브에이전트에 모델 이름 표시",
    agentTitleOff: "서브에이전트 모델 이름 표시 끄기",
    agentTitleDone: (on: boolean): string => (on ? "켰습니다. 새로 뜨는 서브에이전트 제목이 \"Terra·high · …\"처럼 보입니다." : "껐습니다."),
    signInChatgpt: "ChatGPT 로그인…",
    connectClaudeSubscription: "Claude 구독 연결…",
    copyStatus: "상태 복사",
    showLogs: "로그 보기",
    rerunSetup: "ClaudeRipple 설정 다시 실행…",
    setupTitle: "ClaudeRipple을 설정합니다",
    setupPrompt: "로컬 인증서 생성, Claude Code 설정(~/.claude/settings.json) 연결, 백그라운드 라우터 등록을 진행합니다. 계속할까요?",
    setupLater: "나중에",
    setupContinue: "계속",
    setupDone: "ClaudeRipple 설정이 완료되었습니다.",
    setupFailed: "설정을 마치지 못했습니다",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `지금 떠 있는 라우터는 ${from}입니다. 이 버전으로 바꿉니다…`,
    updatedFailed: "라우터를 이 버전으로 바꾸지 못했습니다",
    problem: (code: string) =>
      code === "settings" ? "Claude Code가 ClaudeRipple을 거치지 않음"
      : code === "upstream" ? "Anthropic에 연결 안 됨"
      : code === "picker-ca" ? "피커 모드: 인증서 미신뢰"
      : code === "picker-proxy" ? "피커 모드: Claude Desktop 프록시 미설정"
      : code.startsWith("provider:") ? `프로바이더 ${code.slice(9)} 연결 안 됨`
      : code,
    about: "ClaudeRipple 정보",
    aboutDetail:
      "Claude Desktop을 끄지 않고 그 안에서 GPT 등 다른 모델을 씁니다.\n\n독립 오픈소스 프로젝트(GPL-3.0)이며 Anthropic·OpenAI와 제휴·보증·후원 관계가 없습니다. Claude와 Claude Code는 Anthropic, PBC의 상표입니다.",
    quit: "종료",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: 라우터가 꺼져 있어 Claude Desktop이 연결되지 않습니다",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `프록시 ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "로그인 시 자동 시작",
    downNotifyTitle: "Claude Desktop이 연결되지 않습니다",
    downNotifyBody: "ClaudeRipple 라우터가 꺼져 있어 Claude Desktop이 밖으로 나가지 못합니다. 눌러서 시작하세요.",
    starting: "라우터를 시작하는 중…",
    openDashboard: "브라우저에서 대시보드 열기…",
    offlineHeading: "라우터가 꺼져 있습니다",
    offlineBody:
      "Claude Desktop은 모든 통신을 ClaudeRipple로 보냅니다. 그래서 라우터가 꺼져 있는 동안에는 앱이 흰 화면과 ERR_PROXY_CONNECTION_FAILED만 보여줍니다. 라우터를 시작한 뒤 Claude Desktop을 새로고침하세요.",
    setupNeeded: "설정이 끝나지 않았습니다",
    setupNeededDetail: "설치는 됐지만 아직 설정하지 않았습니다",
    runSetup: "ClaudeRipple 설정 마치기…",
  },
};

let L = STRINGS.en;

function readConfigPorts(): { proxy: number; admin: number } {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { listen?: { port?: number }; admin?: { port?: number } };
    const proxy = c.listen?.port ?? 8790;
    return { proxy, admin: c.admin?.port ?? proxy + 1 };
  } catch {
    return { proxy: 8790, admin: 8791 };
  }
}

let tray: Tray | null = null;
let last: Status | null = null;
let lastError: string | null = null;
let starting = false;
let downSince: number | null = null;
let downNotified = false;
// Long enough that a router still coming up after login does not fire a notification.
const DOWN_NOTIFY_AFTER_MS = 20_000;

// ---- login item ------------------------------------------------------------------------
// The tray app has to be running before the user opens Claude Desktop: with the router down the
// app shows nothing but ERR_PROXY_CONNECTION_FAILED, and the tray is the only place that says why.

const stateFile = path.join(home, "app.json");

function appState(): { loginItemInitialized?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as { loginItemInitialized?: boolean };
  } catch {
    return {};
  }
}

function writeAppState(patch: Record<string, unknown>): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ ...appState(), ...patch }, null, 2)}\n`);
  } catch {
    /* a read-only home only costs us the remembered default */
  }
}

function loginItemOn(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItem(on: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: on });
  } catch {
    /* macOS may refuse in an unsigned development build */
  }
  writeAppState({ loginItemInitialized: true });
}

function adminUrl(): string {
  return `http://127.0.0.1:${readConfigPorts().admin}/`;
}

/**
 * The language the user actually set in the OS. `app.getLocale()` is Chromium's app locale and
 * reads `en-US` on a Korean Windows (measured 2026-09-14), so the tray, notifications and the GUI
 * came up in English there. macOS happened to agree, which hid it.
 */
function uiLang(): "ko" | "en" {
  const candidates = [...app.getPreferredSystemLanguages(), app.getSystemLocale(), app.getLocale()];
  const first = candidates.find((l) => typeof l === "string" && l.length > 0) ?? "en";
  return first.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** The GUI follows the OS language by default; a language the user picked in the GUI itself wins (it is stored in the page). */
function guiUrl(): string {
  return `${adminUrl()}?lang=${uiLang()}`;
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${adminUrl()}api/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    last = (await res.json()) as Status;
    lastError = null;
    downSince = null;
    downNotified = false;
    void reconcileRouter(last);
  } catch (e) {
    last = null;
    lastError = (e as Error).message;
    downSince ??= Date.now();
    if (!downNotified && Date.now() - downSince >= DOWN_NOTIFY_AFTER_MS) {
      downNotified = true;
      notifyDown();
    }
  }
  render();
}

/** The router being down means Claude Desktop is dead in the water, so say so out loud. */
function notifyDown(): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: L.downNotifyTitle, body: L.downNotifyBody });
  n.on("click", () => void startRouter());
  n.show();
}

/** Idempotent: `clauderipple start` leaves a router that is already coming up alone. */
async function startRouter(): Promise<string> {
  if (starting) return L.starting;
  starting = true;
  try {
    return await runCli(["start"]);
  } finally {
    starting = false;
    void poll();
  }
}

function healthy(s: Status | null): "ok" | "warn" | "down" {
  if (!s) return "down";
  const proxyOk = s.settings.HTTPS_PROXY === `http://127.0.0.1:${s.listen.port}`;
  const providersOk = Object.values(s.providers).every((p) => p.reachable !== false);
  if (!proxyOk || s.consecutiveUpstreamFailures > 0) return "warn";
  return providersOk ? "ok" : "warn";
}

const isMac = process.platform === "darwin";

/**
 * macOS tints template images (black + alpha) to match the menu bar. Windows does not, so the same
 * mark would vanish on a dark taskbar — it gets a coloured variant instead, which also lets the
 * state read as a colour rather than only a shape.
 */
function icon(state: "ok" | "warn" | "down"): Electron.NativeImage {
  const mac = { ok: "trayTemplate.png", warn: "trayWarnTemplate.png", down: "trayDownTemplate.png" };
  const win = { ok: "trayWin.png", warn: "trayWinWarn.png", down: "trayWinDown.png" };
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", (isMac ? mac : win)[state]));
  if (isMac) img.setTemplateImage(true);
  return img;
}

/**
 * The dashboard is a web page served by the router, so it opens in the user's own browser. With
 * the router down there is nothing to open: start it (or run setup, when that is what is missing)
 * and open the page once it answers, rather than sending the browser to a refused connection.
 */
async function openDashboard(): Promise<void> {
  if (last) {
    void shell.openExternal(guiUrl());
    return;
  }
  // Before setup there is no router to start, so offer the step that is actually missing.
  const message = needsSetup() ? (await setup(), "") : await startRouter();
  // startRouter() returns once the CLI has finished; ask the router itself rather than waiting
  // for the next tick, since the user is standing in front of the menu.
  await poll();
  if (last) {
    void shell.openExternal(guiUrl());
    return;
  }
  await dialog.showMessageBox({ type: "warning", message: L.offlineHeading, detail: [L.offlineBody, message].filter(Boolean).join("\n\n") });
}

type CliRuntime = { node: string; env: Record<string, string>; cli: string; router?: string };

// ---- update handling -------------------------------------------------------------------
// Installing a new version replaces files, not the process: the supervisor started the router at
// logon from the previous files, and `start` leaves a running router alone. So after an update
// the old router kept serving — the 0.1.1 fixes never ran on the Windows install that reported
// the bugs (2026-09-15). A zip unpacked next to the old folder is worse: the supervisor and
// paths.json still name the old folder, so even a restart brings the old code back.
//
// Once per app run, when the router answers: if it runs another version, restart it; if this
// installation's files are not the ones recorded, re-run `install` first so the supervisor
// points here. A source checkout recorded in paths.json is a developer's choice and is left alone.

let reconciled = false;

function savedPaths(): { node?: string; cli?: string; router?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "paths.json"), "utf8")) as { node?: string; cli?: string; router?: string };
  } catch {
    return null;
  }
}

/** A router path inside a packaged app (macOS .app bundle or electron-builder resources). */
function looksPackaged(routerPath: string): boolean {
  return /\.app[\\/]Contents[\\/]Resources[\\/]clauderipple[\\/]/.test(routerPath) || /[\\/]resources[\\/]clauderipple[\\/]/i.test(routerPath);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

async function reconcileRouter(s: Status): Promise<void> {
  if (reconciled) return;
  const packaged = packagedRuntime();
  if (!packaged?.router) return; // development shell: never touch a checkout's router
  const saved = savedPaths();
  if (!saved?.router || !looksPackaged(saved.router)) return;
  const installedElsewhere = !samePath(saved.router, packaged.router);
  const runningElsewhere = !!s.runtime?.router && !samePath(s.runtime.router, packaged.router);
  const otherVersion = s.version !== app.getVersion();
  if (!installedElsewhere && !runningElsewhere && !otherVersion) return;
  reconciled = true;
  const from = `${s.version}${s.runtime?.router ? ` (${s.runtime.router})` : ""}`;
  if (Notification.isSupported()) new Notification({ title: L.updatedTitle(app.getVersion()), body: L.updatedRestarting(from) }).show();
  const outputs: string[] = [];
  if (installedElsewhere || runningElsewhere) outputs.push(await runCli(["install"]));
  outputs.push(await runCli(["restart"]));
  const out = outputs.join("\n\n");
  if (/✗|error|failed|not restarted|start failed/i.test(out)) {
    await dialog.showMessageBox({ type: "warning", message: L.updatedFailed, detail: out });
  }
  void poll();
}

/**
 * The sources this app carries, when it is a packaged build. macOS keeps them inside the .app;
 * electron-builder puts them next to app.asar everywhere else.
 *
 * This used to match only the macOS bundle path, so on Windows it returned null — which made
 * needsSetup() answer false and the first-run setup prompt never appear. The app installed, said
 * "router not running", and left the user with no way to find out what to do (2026-09-14).
 */
function packagedRuntime(): CliRuntime | null {
  const macBundle = process.execPath.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  const resources = macBundle
    ? path.join(macBundle, "Contents", "Resources", "clauderipple")
    : path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "", "clauderipple");
  const cli = path.join(resources, "packages", "cli", "src", "index.ts");
  if (!fs.existsSync(cli)) return null;
  return { node: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, cli, router: path.join(resources, "packages", "router", "src", "index.ts") };
}

/** Prefer this app's bundled Electron runtime; existing installations retain their recorded runtime. */
function cliPaths(): CliRuntime {
  const packaged = packagedRuntime();
  if (packaged && fs.existsSync(packaged.cli)) return packaged;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(home, "paths.json"), "utf8")) as { node?: string; env?: Record<string, string>; cli?: string };
    if (p.node && p.cli && fs.existsSync(p.node) && fs.existsSync(p.cli)) return { node: p.node, env: p.env ?? {}, cli: p.cli };
  } catch {
    /* fall through to the development layout */
  }
  // process.execPath is Electron: without ELECTRON_RUN_AS_NODE it launches a second app instead of
  // running the CLI, and that instance never exits (observed 2026-09-14 with no paths.json).
  // A checkout keeps the CLI two levels up as TypeScript; an npm install has the built JavaScript
  // in the same place, since the tray is copied into the same tree it was built beside.
  const nearby = [path.resolve(__dirname, "..", "..", "cli", "src", "index.ts"), path.resolve(__dirname, "..", "..", "cli", "src", "index.js")];
  const cli = nearby.find((candidate) => fs.existsSync(candidate)) ?? nearby[0]!;
  return { node: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, cli };
}

function runCli(args: string[]): Promise<string> {
  const { node, env, cli } = cliPaths();
  return new Promise((resolve) => {
    execFile(node, [cli, ...args], { env: { ...process.env, ...env, CLAUDERIPPLE_HOME: home } }, (err, stdout, stderr) => {
      resolve(`${stdout}${stderr}${err ? `\n${err.message}` : ""}`.trim());
    });
  });
}

// Offer setup only when there is no working installation at all. A developer who runs the router
// from a source checkout keeps that; switching to the app's bundled runtime is a menu action.
function needsSetup(): boolean {
  const current = packagedRuntime();
  if (!current) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(home, "paths.json"), "utf8")) as { node?: string; cli?: string; router?: string };
    const usable = !!saved.node && !!saved.router && fs.existsSync(saved.node) && fs.existsSync(saved.router);
    return !usable;
  } catch {
    return true;
  }
}

async function setup(): Promise<void> {
  const out = await runCli(["install"]);
  // `install` marks each step with ✓ or ✗ and ends on a failed probe; saying "finished" over a
  // failure would send the user away believing it worked.
  const failed = out.includes("✗") || /error|failed/i.test(out);
  await dialog.showMessageBox({
    type: failed ? "warning" : "info",
    message: failed ? L.setupFailed : L.setupDone,
    detail: out,
  });
  void poll();
}

async function promptForSetup(): Promise<void> {
  const choice = await dialog.showMessageBox({
    title: "ClaudeRipple",
    message: L.setupTitle,
    detail: L.setupPrompt,
    buttons: [L.setupContinue, L.setupLater],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response === 0) await setup();
}

function render(): void {
  if (!tray) return;
  const state = healthy(last);
  tray.setImage(icon(state));
  const s = last;
  const quota = Object.values(s?.chatgpt?.quota ?? {}).find((q) => q) as { plan_type?: string; rate_limits?: { primary?: { used_percent?: number; reset_after_seconds?: number } } } | undefined;
  const quotaLine = quota?.rate_limits?.primary
    ? L.percentOfWeekUsed(quota.rate_limits.primary.used_percent ?? "?", quota.plan_type ?? "")
    : null;
  // Two status lines (clickable: they open the window), then only the actions that need the tray.
  // Everything else lives in the GUI window. Disabled items render grey, so the status lines stay enabled.
  const connected = !!s && s.settings.HTTPS_PROXY === `http://127.0.0.1:${s.listen.port}`;
  // "Router not running" is useless advice to someone who has never set it up — that reads as a
  // fault when the truth is there is one step left. Separate the two states everywhere.
  const unconfigured = !s && needsSetup();
  const headline = s
    ? `ClaudeRipple · ${state === "ok" ? L.healthy : L.attentionNeeded}`
    : `ClaudeRipple · ${unconfigured ? L.setupNeeded : L.routerNotRunning}`;
  // What is actually in the way, not only that something is: the router's readiness list names it.
  const problems = (s?.readiness?.problems ?? []).map((code) => L.problem(code));
  const detail = s
    ? [connected ? L.connected : L.notConnected, ...problems, quotaLine].filter(Boolean).join(" · ")
    : unconfigured
      ? L.setupNeededDetail
      : L.downNotifyTitle;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: headline, click: () => void openDashboard() },
    ...(detail ? [{ label: detail, click: () => void openDashboard() } as Electron.MenuItemConstructorOptions] : []),
    { type: "separator" },
    // Enabled even when the router is down: it is started first, then the page is opened.
    { label: L.openDashboard, click: () => void openDashboard() },
    { label: L.startAtLogin, type: "checkbox", checked: loginItemOn(), click: (item) => setLoginItem(item.checked) },
    { type: "separator" },
    { label: unconfigured ? L.runSetup : L.rerunSetup, click: () => void setup() },
    ...(unconfigured
      ? []
      : [
          {
            label: s ? L.restartRouter : L.startRouter,
            click: async () => void dialog.showMessageBox({ message: s ? await runCli(["restart"]) : await startRouter() }),
          } as Electron.MenuItemConstructorOptions,
        ]),
    // Only offered while a ChatGPT provider has no usable credentials (own login or a reused Codex CLI login).
    ...(s && Object.values(s.chatgpt?.signedIn ?? {}).some((ok) => !ok)
      ? [{ label: L.signInChatgpt, click: async () => void dialog.showMessageBox({ message: await runCli(["login"]) }) } as Electron.MenuItemConstructorOptions]
      : []),
    { label: L.connectClaudeSubscription, click: async () => void dialog.showMessageBox({ message: await runCli(["claude-login"]) }) },
    { type: "separator" },
    { label: L.about, click: () => void dialog.showMessageBox({ title: "ClaudeRipple", message: "ClaudeRipple", detail: L.aboutDetail }) },
    { label: L.quit, role: "quit" },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(s ? L.tooltip(state) : L.tooltipDown);
}

app.whenReady().then(() => {
  L = STRINGS[uiLang()];
  // Without this, Windows attributes our notifications to "Electron" instead of ClaudeRipple.
  if (process.platform === "win32") app.setAppUserModelId("com.clauderipple.app");
  // macOS keeps its application menu (it owns Cmd-Q and the edit shortcuts); elsewhere it is noise.
  if (!isMac) Menu.setApplicationMenu(null);
  if (isMac) app.dock?.hide();
  // Default to starting at login on first run; after that the user's choice stands.
  if (!appState().loginItemInitialized) setLoginItem(true);
  tray = new Tray(icon("down"));
  tray.on("click", () => tray?.popUpContextMenu());
  render();
  void poll();
  setInterval(() => void poll(), POLL_MS);
  if (needsSetup()) void promptForSetup();
});

// A tray-only app owns no windows; without this Electron would quit the moment a dialog closes.
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
