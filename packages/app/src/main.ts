// ClaudeRipple menu-bar app. The router owns the logic and the admin API on 127.0.0.1; this shell
// adds a tray icon with live health, the dashboard window, and shortcuts for restart / logs / login.
//
// The window draws the dashboard from the app's own copy of packages/ui (protocol.ts) and only asks
// the router for data, so it opens with the router dead — which is when it is needed: on
// 2026-10-20 a broken launch entry took the router down, and the router-served dashboard with it,
// and nothing was left to fix it from. A preload bridge lets the dashboard repair the router or
// switch Claude to its default connection through the CLI (`doctor` / `repair` / `direct`).

import { app, Menu, Tray, Notification, nativeImage, shell, dialog, clipboard, ipcMain } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeStartedAt, reopenClaude } from "./claude-desktop";
import { failureAction, failureKinds, type FailureAction, type FailureKind } from "./failure-model";
import { readUpdateSeen, readReplacementTries, rememberUpdate, replacementExhausted, nextReplacementTries, resolveTrayVersion, updateNotice, TrayReplacement, REPLACEMENT_LIMIT, type ReplacementTries, type RouterUpdate, type UpdateSeen } from "./update-model";
import { handleScheme, ORIGIN, registerScheme } from "./protocol";
import { parseJsonOutput, repairDetails, restartStillOwed, shouldNotifyDown, tailLines, trayState, type Action, type ActionResult, type AppState, type Busy, type DirectOutput, type Doctor, type RepairOutput } from "./status-model";
import { mainWindow, openWindow, sendToWindow, windowVisible, type Bounds } from "./window";

type QuotaWindow = { used_percent?: number; window_minutes?: number };
type Quota = { plan_type?: string; rate_limits?: { primary?: QuotaWindow | null; secondary?: QuotaWindow | null } };

type Status = {
  version: string;
  autoUpdate?: RouterUpdate;
  /** Reported from 0.1.2 on; an older router leaves it out. */
  runtime?: { node: string; router: string | null; startedAt: string };
  /** Reported from 0.1.2 on: whether requests can actually go through, and what is in the way. */
  readiness?: { ready: boolean; problems: ("settings" | "upstream" | "picker-ca" | "picker-proxy" | "config" | `provider:${string}`)[] };
  listen: { host: string; port: number };
  adminPort: number;
  stats: { started: number; completed: number; failed: number; inFlight: number };
  consecutiveUpstreamFailures: number;
  routes: number;
  providers: Record<string, { url?: string; reachable: boolean; type?: string }>;
  settings: { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string };
  cliVersion: string;
  chatgpt?: { quota: Record<string, Quota | null>; auth: Record<string, string>; signedIn?: Record<string, boolean> };
  /** Reported from 0.6.0 on, where a Claude subscription provider is configured. */
  claude?: { accounts: { id: string; label: string; quota: Quota }[] };
  picker?: { enabled: boolean; hosts: string[]; last: unknown };
  agentTitle?: boolean;
};

type AwakeMode = "off" | "working" | "on";
/** `GET /api/power` (router power.ts), the fields the tray shows. Absent before 0.10 (501). */
type Power = {
  platform: string;
  awake: { mode: AwakeMode; setup: "ok" | "needs-setup" | "unsupported" };
  tether: { enabled: boolean };
};

const home = process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple");
const POLL_MS = 5000;

/**
 * The version of this tray, the one place it is asked for. `electron path/to/main.js` — how the CLI
 * starts an npm install on every platform — makes app.getVersion() answer with Electron's version,
 * not the package's: in 0.12.14 it said 38.8.6 while the router said 0.12.14, so the tray saw a new
 * version on every poll and replaced itself about every two seconds (Discord report). The
 * package.json beside the tray's dist/ is the one build-npm writes the published version into; a
 * checkout keeps it in packages/app; a packaged build carries it in its bundle and needs no help.
 */
function trayVersion(): string {
  let beside: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") beside = pkg.version;
  } catch {
    /* no package.json beside the tray: Electron's own answer is all there is */
  }
  return resolveTrayVersion(app.isPackaged, app.getVersion(), beside);
}

// ---- i18n: tray menu, dialogs, tooltips -------------------------------------------------

/** A title and a sentence for every failure the failure dialog can name, in every language. */
function failureText(text: Record<FailureKind, [title: string, body: string]>): Record<FailureKind, [title: string, body: string]> {
  return text;
}

const STRINGS = {
  en: {
    healthy: "healthy",
    attentionNeeded: "attention needed",
    routerNotRunning: "router not running",
    slotsMapped: (n: number) => `${n} slot${n === 1 ? "" : "s"} mapped`,
    inFlight: "in flight",
    connected: "Claude Desktop connected",
    notConnected: "Claude Desktop not connected",
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "Restart Router",
    startRouter: "Start Router",
    pickerOn: "Show GPT models in the Code tab picker…",
    pickerOff: "Hide GPT models in the model picker…",
    pickerState: (on: boolean): string => (on ? "Model picker: GPT models shown by name ✓" : "Model picker: GPT models via Claude names (alias mode)"),
    pickerOnConfirm: "macOS will ask for your login password to trust the ClaudeRipple certificate (ClaudeRipple never sees it). Then quit Claude Desktop completely and open it again.",
    pickerDone: "Done. Quit Claude Desktop completely, open it again, and check the model picker in the Code tab.",
    pickerOffDone: "Done. Quit Claude Desktop completely and open it again to apply the change.",
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
    setupFailed: "ClaudeRipple setup did not finish.",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `The running router is ${from}. Switching it to this version…`,
    updatedFailed: "The router could not be switched to the new version.",
    problem: (code: string) =>
      code === "settings" ? "Claude Code is not pointed at ClaudeRipple"
      : code === "upstream" ? "Anthropic is unreachable"
      : code === "picker-ca" ? "picker mode: certificate not trusted"
      : code === "picker-proxy" ? "picker mode: Claude Desktop proxy not set"
      : code === "config" ? "the config file has errors"
      : code.startsWith("provider:") ? `provider ${code.slice(9)} unreachable`
      : code,
    about: "About ClaudeRipple",
    aboutDetail:
      "Use GPT and many other models alongside Claude, without quitting Claude Desktop.\n\nIndependent open-source project (GPL-3.0). Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC.",
    quit: "Quit",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: router not running — Claude Desktop cannot connect",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "Start at login",
    downNotifyTitle: "Claude Desktop cannot connect",
    starting: "starting the router…",
    open: "Open ClaudeRipple…",
    directHeadline: "Claude's default connection (Ripple off)",
    tooltipDirect: "ClaudeRipple: using Claude's default connection",
    notifyDownTitle: "Ripple is not responding",
    notifyDownBody: "Claude cannot reach AI right now. Repair Ripple, or switch to Claude's default connection.",
    actRepair: "Repair",
    actDirectOn: "Use Claude's default connection",
    restartConfirm: "Quit and reopen the Claude app?",
    restartConfirmDetail: "Open conversations and any work in progress in the Claude app will stop.",
    restartNow: "Reopen",
    setupNeeded: "setup not finished",
    setupNeededDetail: "ClaudeRipple is installed but not set up yet",
    runSetup: "Finish setting up ClaudeRipple…",
    claudeCurrent: "current login",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5h",
    windowWeek: "weekly",
    checkUpdates: "Check for Updates…",
    updateAvailableItem: (v: string) => `Update to ClaudeRipple ${v}…`,
    upToDate: (v: string) => `ClaudeRipple ${v} is the latest version.`,
    updateAvailable: (latest: string, current: string) => `ClaudeRipple ${latest} is available (you have ${current}).`,
    updateDetail: "The router restarts on the new version once all requests in flight have finished. The tray app relaunches by itself.",
    updateNow: "Update",
    later: "Later",
    updating: (v: string) => `Updating to ClaudeRipple ${v}…`,
    autoUpdated: (v: string) => `ClaudeRipple has been updated to ${v}.`,
    autoAvailable: (v: string) => `Version ${v} is available. Click to update.`,
    updateDone: (v: string) => `The update to ClaudeRipple ${v} is complete.`,
    updateFailed: "The update did not finish.",
    close: "Close",
    failureDetails: "Details",
    failureOutput: "Full output",
    failureOutputCopied: "Full output (copied)",
    copyOutput: "Copy",
    setupAgain: "Run Setup Again",
    tryAgain: "Try Again",
    routerRestarted: "Router restarted",
    failures: failureText({
      "router-not-switched": ["Router still on the old version", "The new version is installed, but the router running now is the old one. Restarting the router switches it to the new version."],
      "router-not-started": ["Router not started", "The router could not be started. Repair registers its startup entry again and starts it."],
      "startup-entry": ["Startup entry problem", "The entry that starts the router at login could not be registered or run. Repair registers it again."],
      "certificate": ["Certificate problem", "The router's local certificate could not be read or does not match. Run setup again."],
      "router-unresponsive": ["Router not responding", "The router did not answer the final connection check. This often happens while other programs keep the CPU busy. Run setup again in a moment."],
      "anthropic-unreachable": ["Anthropic unreachable", "The router answered, but could not reach Anthropic. Check your internet connection, then run setup again."],
      "foreign-proxy": ["Another proxy in use", "Claude Code is set to use another proxy, so its settings were left as they were. Turn that proxy off, then run setup again."],
      "disk-full": ["Disk full", "There is not enough disk space to install. Free up space, then try again."],
      "files-unwritable": ["Files could not be replaced", "Files in the install folder are in use, or this account cannot write to them. Try again in a moment."],
      "download": ["Download failed", "The new version could not be downloaded. Check your internet connection, then try again."],
      "unknown": ["Unknown error", "No known cause was found in the output. The full output is under Details."],
    }),
    trayReplaceGaveUp: (v: string) => `The tray app could not switch to the new version. It keeps running as version ${v}. See the tray log for details.`,
    updateCheckFailed: "Could not check for updates.",
    updatePackaged: "This is the standalone app. Download the new version from the releases page.",
    updateCheckout: "This is a source checkout. Update it with git pull.",
    awakeMenu: (mode: string) => `Keep laptop awake · ${mode}`,
    awakeOff: "Off",
    awakeWorking: "Only while working",
    awakeOn: "Always",
    tetherItem: "Phone hotspot if Wi-Fi drops (auto)",
    laptopOpen: "Open Laptop settings…",
    laptopSetup: "Set up laptop features…",
  },
  ko: {
    healthy: "정상",
    attentionNeeded: "확인 필요",
    routerNotRunning: "리플 꺼짐",
    slotsMapped: (n: number) => `슬롯 ${n}개 연결`,
    inFlight: "진행 중",
    connected: "Claude Desktop 연결됨",
    notConnected: "Claude Desktop 연결 안 됨",
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "리플 재시작",
    startRouter: "리플 시작",
    pickerOn: "Code 탭 모델 피커에 GPT 모델 표시…",
    pickerOff: "모델 피커에서 GPT 모델 숨기기…",
    pickerState: (on: boolean): string => (on ? "모델 피커: GPT 모델 이름 표시 중 ✓" : "모델 피커: Claude 이름으로 GPT 사용 (별칭 모드)"),
    pickerOnConfirm: "ClaudeRipple 인증서를 신뢰하려면 macOS 로그인 암호를 입력해야 합니다(ClaudeRipple은 암호를 보지 않습니다). 완료 후 Claude Desktop을 완전히 종료한 뒤 다시 실행해 주세요.",
    pickerDone: "설정이 완료되었습니다. Claude Desktop을 완전히 종료한 뒤 다시 실행하여 Code 탭의 모델 피커를 확인해 주세요.",
    pickerOffDone: "설정이 완료되었습니다. Claude Desktop을 완전히 종료한 뒤 다시 실행하면 적용됩니다.",
    cancel: "취소",
    agentTitleOn: "서브에이전트에 모델 이름 표시",
    agentTitleOff: "서브에이전트 모델 이름 숨기기",
    agentTitleDone: (on: boolean): string => (on ? "켰습니다. 새로 시작하는 서브에이전트 제목이 \"Terra·high · …\"처럼 표시됩니다." : "껐습니다."),
    signInChatgpt: "ChatGPT 로그인…",
    connectClaudeSubscription: "Claude 구독 연결…",
    copyStatus: "상태 복사",
    showLogs: "로그 보기",
    rerunSetup: "ClaudeRipple 설정 다시 실행…",
    setupTitle: "ClaudeRipple 설정",
    setupPrompt: "로컬 인증서를 생성하고, Claude Code 설정(~/.claude/settings.json)을 연결하며, 리플이 백그라운드에서 실행되도록 등록합니다. 계속하시겠습니까?",
    setupLater: "나중에",
    setupContinue: "계속",
    setupDone: "ClaudeRipple 설정이 완료되었습니다.",
    setupFailed: "ClaudeRipple 설정을 완료하지 못했습니다.",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `현재 실행 중인 리플은 ${from} 버전입니다. 새 버전으로 전환합니다…`,
    updatedFailed: "리플을 새 버전으로 전환하지 못했습니다.",
    problem: (code: string) =>
      code === "settings" ? "Claude Code가 ClaudeRipple에 연결되지 않음"
      : code === "upstream" ? "Anthropic 연결 안 됨"
      : code === "picker-ca" ? "피커 모드: 인증서 신뢰 필요"
      : code === "picker-proxy" ? "피커 모드: Claude Desktop 프록시 설정 필요"
      : code === "config" ? "설정 파일에 오류가 있음"
      : code.startsWith("provider:") ? `프로바이더 ${code.slice(9)} 연결 안 됨`
      : code,
    about: "ClaudeRipple 정보",
    aboutDetail:
      "Claude Desktop을 종료하지 않고 GPT 등 다양한 모델을 함께 사용할 수 있습니다.\n\n독립 오픈소스 프로젝트(GPL-3.0)이며 Anthropic·OpenAI와 제휴·보증·후원 관계가 없습니다. Claude와 Claude Code는 Anthropic, PBC의 상표입니다.",
    quit: "종료",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: 리플이 꺼져 있어 Claude Desktop이 연결되지 않습니다",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `프록시 ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "로그인 시 자동 시작",
    downNotifyTitle: "Claude Desktop이 연결되지 않습니다",
    starting: "리플을 시작하는 중…",
    open: "ClaudeRipple 열기…",
    directHeadline: "Claude 기본 연결 사용 중 (리플 꺼짐)",
    tooltipDirect: "ClaudeRipple: Claude 기본 연결 사용 중",
    notifyDownTitle: "리플이 응답하지 않습니다",
    notifyDownBody: "지금 Claude가 AI에 연결되지 않습니다. 리플을 복구하거나 Claude 기본 연결로 전환할 수 있습니다.",
    actRepair: "복구",
    actDirectOn: "Claude 기본 연결로 전환",
    restartConfirm: "Claude 앱을 종료했다가 다시 여시겠습니까?",
    restartConfirmDetail: "Claude 앱의 열린 대화와 진행 중인 작업이 중단됩니다.",
    restartNow: "다시 열기",
    setupNeeded: "설정 필요",
    setupNeededDetail: "ClaudeRipple이 설치되었지만 아직 설정이 완료되지 않았습니다.",
    runSetup: "ClaudeRipple 설정 완료하기…",
    claudeCurrent: "현재 로그인",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5시간",
    windowWeek: "주간",
    checkUpdates: "업데이트 확인…",
    updateAvailableItem: (v: string) => `ClaudeRipple ${v} 버전으로 업데이트…`,
    upToDate: (v: string) => `현재 최신 버전을 사용하고 있습니다 (ClaudeRipple ${v}).`,
    updateAvailable: (latest: string, current: string) => `새로운 버전을 사용할 수 있습니다: ClaudeRipple ${latest} (현재 버전: ${current}).`,
    updateDetail: "진행 중인 요청이 모두 끝나면 리플이 새 버전으로 재시작됩니다. 트레이 앱은 자동으로 다시 실행됩니다.",
    updateNow: "업데이트",
    later: "나중에",
    updating: (v: string) => `ClaudeRipple ${v} 업데이트 중…`,
    autoUpdated: (v: string) => `ClaudeRipple ${v} 버전으로 업데이트되었습니다.`,
    autoAvailable: (v: string) => `새로운 ${v} 버전을 사용할 수 있습니다. 클릭하여 업데이트해 주세요.`,
    updateDone: (v: string) => `ClaudeRipple ${v} 버전으로 업데이트를 완료했습니다.`,
    updateFailed: "업데이트를 완료하지 못했습니다.",
    close: "닫기",
    failureDetails: "자세히",
    failureOutput: "전체 출력",
    failureOutputCopied: "전체 출력 (복사됨)",
    copyOutput: "복사",
    setupAgain: "설정 다시 실행",
    tryAgain: "다시 시도",
    routerRestarted: "리플 재시작 완료",
    failures: failureText({
      "router-not-switched": ["리플이 이전 버전으로 실행 중", "새 버전은 설치되었지만 지금 실행 중인 리플은 이전 버전입니다. 리플을 재시작하면 새 버전으로 바뀝니다."],
      "router-not-started": ["리플 시작 안 됨", "리플을 시작하지 못했습니다. 복구하면 시작 항목을 다시 등록하고 리플을 시작합니다."],
      "startup-entry": ["시작 항목 문제", "로그인할 때 리플을 시작하는 항목을 등록하거나 실행하지 못했습니다. 복구하면 이 항목을 다시 등록합니다."],
      "certificate": ["인증서 문제", "리플의 로컬 인증서를 읽지 못했거나 인증서가 올바르지 않습니다. 설정을 다시 실행해 주세요."],
      "router-unresponsive": ["리플 응답 없음", "리플이 마지막 연결 확인에 응답하지 않았습니다. 다른 프로그램이 CPU를 많이 사용할 때 자주 발생합니다. 잠시 후 설정을 다시 실행해 주세요."],
      "anthropic-unreachable": ["Anthropic 연결 안 됨", "리플은 응답했지만 Anthropic에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 설정을 다시 실행해 주세요."],
      "foreign-proxy": ["다른 프록시 사용 중", "Claude Code가 다른 프록시를 사용하도록 설정되어 있어 설정을 변경하지 않았습니다. 해당 프록시 설정을 해제한 뒤 설정을 다시 실행해 주세요."],
      "disk-full": ["디스크 공간 부족", "설치에 필요한 디스크 공간이 부족합니다. 디스크 여유 공간을 확보한 뒤 다시 시도해 주세요."],
      "files-unwritable": ["파일 교체 실패", "설치 폴더의 파일이 사용 중이거나 현재 계정에 쓰기 권한이 없습니다. 잠시 후 다시 시도해 주세요."],
      "download": ["다운로드 실패", "새 버전을 다운로드하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요."],
      "unknown": ["알 수 없는 오류", "알려진 오류 원인을 찾지 못했습니다. 전체 출력은 '자세히'에서 확인할 수 있습니다."],
    }),
    trayReplaceGaveUp: (v: string) => `트레이 앱을 새 버전으로 전환하지 못했습니다. 트레이 앱은 ${v} 버전으로 계속 실행됩니다. 자세한 내용은 트레이 로그에서 확인할 수 있습니다.`,
    updateCheckFailed: "업데이트 정보를 확인하지 못했습니다.",
    updatePackaged: "설치형 앱입니다. 릴리스 페이지에서 최신 버전을 다운로드해 주세요.",
    updateCheckout: "소스 코드로 실행 중입니다. git pull 명령으로 업데이트해 주세요.",
    awakeMenu: (mode: string) => `노트북 잠자기 방지 · ${mode}`,
    awakeOff: "끔",
    awakeWorking: "작업 중에만",
    awakeOn: "항상 유지",
    tetherItem: "와이파이가 끊기면 휴대폰 핫스팟으로 자동 전환",
    laptopOpen: "노트북 관리 열기…",
    laptopSetup: "노트북 기능 설정…",
  },
  zh: {
    healthy: "运行正常",
    attentionNeeded: "需要处理",
    routerNotRunning: "路由服务未运行",
    slotsMapped: (n: number) => `已映射 ${n} 个槽位`,
    inFlight: "进行中",
    connected: "Claude Desktop 已连接",
    notConnected: "Claude Desktop 未连接",
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "重启路由服务",
    startRouter: "启动路由服务",
    pickerOn: "在 Code 标签页的模型选择器中显示 GPT 模型…",
    pickerOff: "不再在模型选择器中显示 GPT 模型…",
    pickerState: (on: boolean): string => (on ? "模型选择器：以真实名称显示 GPT 模型 ✓" : "模型选择器：通过 Claude 模型名使用 GPT 模型（别名模式）"),
    pickerOnConfirm: "macOS 会要求输入登录密码以信任 ClaudeRipple 证书（ClaudeRipple 永远不会看到密码）。之后请完全退出 Claude Desktop，再重新打开。",
    pickerDone: "设置已完成。请完全退出 Claude Desktop 再重新打开，然后查看 Code 标签页的模型选择器。",
    pickerOffDone: "设置已完成。完全退出 Claude Desktop 并重新打开后生效。",
    cancel: "取消",
    agentTitleOn: "在子代理上显示模型名称",
    agentTitleOff: "不再在子代理上显示模型名称",
    agentTitleDone: (on: boolean): string => (on ? "已开启。新的子代理标题将类似于“Terra·high · …”。" : "已关闭。"),
    signInChatgpt: "登录 ChatGPT…",
    connectClaudeSubscription: "连接 Claude 订阅…",
    copyStatus: "复制状态",
    showLogs: "查看日志",
    rerunSetup: "重新运行 ClaudeRipple 设置…",
    setupTitle: "设置 ClaudeRipple",
    setupPrompt: "ClaudeRipple 将创建本地证书、配置 Claude Code 以连接 ClaudeRipple（~/.claude/settings.json），并注册后台路由服务。是否继续？",
    setupLater: "稍后",
    setupContinue: "继续",
    setupDone: "ClaudeRipple 设置完成。",
    setupFailed: "未能完成 ClaudeRipple 设置。",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `正在运行的路由服务版本为 ${from}，正在切换到当前版本…`,
    updatedFailed: "无法将路由服务切换到新版本。",
    problem: (code: string) =>
      code === "settings" ? "Claude Code 未指向 ClaudeRipple"
      : code === "upstream" ? "无法连接 Anthropic"
      : code === "picker-ca" ? "选择器模式：证书未被信任"
      : code === "picker-proxy" ? "选择器模式：未设置 Claude Desktop 代理"
      : code === "config" ? "设置文件有错误"
      : code.startsWith("provider:") ? `无法连接供应商 ${code.slice(9)}`
      : code,
    about: "关于 ClaudeRipple",
    aboutDetail:
      "无需退出 Claude Desktop，即可同时使用 GPT 等多种模型。\n\n独立开源项目（GPL-3.0）。与 Anthropic 和 OpenAI 均无关联，未获其认可或赞助。Claude 和 Claude Code 是 Anthropic, PBC 的商标。",
    quit: "退出",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple：路由服务未运行 — Claude Desktop 无法连接",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `代理 ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "登录时启动",
    downNotifyTitle: "Claude Desktop 无法连接",
    starting: "正在启动路由服务…",
    open: "打开 ClaudeRipple…",
    directHeadline: "正在使用 Claude 默认连接（Ripple 已关闭）",
    tooltipDirect: "ClaudeRipple：正在使用 Claude 默认连接",
    notifyDownTitle: "Ripple 没有响应",
    notifyDownBody: "Claude 现在无法连接 AI。可以修复 Ripple，或切换到 Claude 默认连接。",
    actRepair: "修复",
    actDirectOn: "切换到 Claude 默认连接",
    restartConfirm: "要退出并重新打开 Claude 应用吗？",
    restartConfirmDetail: "Claude 应用中打开的对话和进行中的工作会停止。",
    restartNow: "重新打开",
    setupNeeded: "设置未完成",
    setupNeededDetail: "ClaudeRipple 已安装，但尚未完成设置",
    runSetup: "完成 ClaudeRipple 设置…",
    claudeCurrent: "当前登录",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5 小时",
    windowWeek: "每周",
    checkUpdates: "检查更新…",
    updateAvailableItem: (v: string) => `更新到 ClaudeRipple ${v}…`,
    upToDate: (v: string) => `ClaudeRipple ${v} 已是最新版本。`,
    updateAvailable: (latest: string, current: string) => `ClaudeRipple ${latest} 已发布（当前版本 ${current}）。`,
    updateDetail: "进行中的请求全部处理完毕后，路由服务会以新版本重启。托盘应用会自动重新启动。",
    updateNow: "更新",
    later: "稍后",
    updating: (v: string) => `正在更新到 ClaudeRipple ${v}…`,
    autoUpdated: (v: string) => `已更新到 ClaudeRipple ${v}。`,
    autoAvailable: (v: string) => `新版本 ${v} 已发布，点击即可更新。`,
    updateDone: (v: string) => `ClaudeRipple ${v} 更新完成。`,
    updateFailed: "更新未完成。",
    close: "关闭",
    failureDetails: "详情",
    failureOutput: "完整输出",
    failureOutputCopied: "完整输出（已复制）",
    copyOutput: "复制",
    setupAgain: "重新运行设置",
    tryAgain: "重试",
    routerRestarted: "路由服务已重启",
    failures: failureText({
      "router-not-switched": ["路由服务仍在运行旧版本", "新版本已安装，但当前运行的路由服务仍是旧版本。重启路由服务即可切换到新版本。"],
      "router-not-started": ["路由服务未启动", "无法启动路由服务。“修复”会重新注册启动项并启动路由服务。"],
      "startup-entry": ["启动项问题", "无法注册或运行登录时启动路由服务的启动项。“修复”会重新注册该启动项。"],
      "certificate": ["证书问题", "无法读取路由服务的本地证书，或证书不匹配。请重新运行设置。"],
      "router-unresponsive": ["路由服务没有响应", "路由服务未响应最后一次连接检查。其他程序大量占用 CPU 时经常会出现这种情况。请稍后重新运行设置。"],
      "anthropic-unreachable": ["无法连接 Anthropic", "路由服务已响应，但无法连接 Anthropic。请检查互联网连接，然后重新运行设置。"],
      "foreign-proxy": ["正在使用其他代理", "Claude Code 已设置为使用其他代理，因此未更改其设置。请关闭该代理，然后重新运行设置。"],
      "disk-full": ["磁盘空间不足", "磁盘空间不足，无法安装。请释放空间后重试。"],
      "files-unwritable": ["无法替换文件", "安装文件夹中的文件正在使用中，或当前账户没有写入权限。请稍后重试。"],
      "download": ["下载失败", "无法下载新版本。请检查互联网连接后重试。"],
      "unknown": ["未知错误", "未在输出中找到已知原因。完整输出可在“详情”中查看。"],
    }),
    trayReplaceGaveUp: (v: string) => `托盘应用无法切换到新版本，将继续以 ${v} 版本运行。详细信息请查看托盘日志。`,
    updateCheckFailed: "无法检查更新。",
    updatePackaged: "这是独立打包的应用。请从发布页面下载新版本。",
    updateCheckout: "这是从仓库检出的源码版本，请用 git pull 更新。",
    awakeMenu: (mode: string) => `笔记本保持唤醒 · ${mode}`,
    awakeOff: "关闭",
    awakeWorking: "仅在工作时",
    awakeOn: "始终保持唤醒",
    tetherItem: "Wi-Fi 断开时自动切换到手机热点",
    laptopOpen: "打开笔记本管理…",
    laptopSetup: "设置笔记本功能…",
  },
  ja: {
    healthy: "正常",
    attentionNeeded: "要確認",
    routerNotRunning: "ルーター停止中",
    slotsMapped: (n: number) => `${n}個のスロットをマッピング済み`,
    inFlight: "処理中",
    connected: "Claude Desktop 接続済み",
    notConnected: "Claude Desktop 未接続",
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "ルーターを再起動",
    startRouter: "ルーターを起動",
    pickerOn: "CodeタブのモデルピッカーにGPTモデルを表示…",
    pickerOff: "モデルピッカーのGPTモデルを非表示にする…",
    pickerState: (on: boolean): string => (on ? "モデルピッカー：GPTモデルを実際の名前で表示 ✓" : "モデルピッカー：Claudeの名前でGPTモデルを使用（エイリアスモード）"),
    pickerOnConfirm: "ClaudeRippleの証明書を信頼するため、macOSがログインパスワードを求めます（ClaudeRippleがパスワードを見ることはありません）。その後、Claude Desktopを完全に終了してから開き直してください。",
    pickerDone: "設定が完了しました。Claude Desktopを完全に終了してから開き直し、Codeタブのモデルピッカーを確認してください。",
    pickerOffDone: "設定が完了しました。Claude Desktopを完全に終了してから開き直すと反映されます。",
    cancel: "キャンセル",
    agentTitleOn: "サブエージェントにモデル名を表示",
    agentTitleOff: "サブエージェントのモデル名を非表示にする",
    agentTitleDone: (on: boolean): string => (on ? "オンにしました。新しいサブエージェントには「Terra·high · …」のようなタイトルが付きます。" : "オフにしました。"),
    signInChatgpt: "ChatGPTにログイン…",
    connectClaudeSubscription: "Claudeサブスクリプションを接続…",
    copyStatus: "ステータスをコピー",
    showLogs: "ログを表示",
    rerunSetup: "ClaudeRippleのセットアップを再実行…",
    setupTitle: "ClaudeRippleのセットアップ",
    setupPrompt: "ClaudeRippleがローカル証明書を作成し、Claude Codeの接続設定（~/.claude/settings.json）を行い、バックグラウンドのルーターを登録します。続けますか？",
    setupLater: "後で",
    setupContinue: "続ける",
    setupDone: "ClaudeRippleのセットアップが完了しました。",
    setupFailed: "ClaudeRippleのセットアップが完了しませんでした。",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `実行中のルーターは ${from} です。このバージョンに切り替えています…`,
    updatedFailed: "ルーターを新しいバージョンに切り替えられませんでした。",
    problem: (code: string) =>
      code === "settings" ? "Claude Codeの接続先がClaudeRippleになっていません"
      : code === "upstream" ? "Anthropicに接続できません"
      : code === "picker-ca" ? "ピッカーモード：証明書が信頼されていません"
      : code === "picker-proxy" ? "ピッカーモード：Claude Desktopのプロキシが未設定です"
      : code === "config" ? "設定ファイルにエラーがあります"
      : code.startsWith("provider:") ? `プロバイダー ${code.slice(9)} に接続できません`
      : code,
    about: "ClaudeRippleについて",
    aboutDetail:
      "Claude Desktopを終了することなく、GPTなどさまざまなモデルをあわせて使えます。\n\n独立したオープンソースプロジェクトです（GPL-3.0）。AnthropicおよびOpenAIとは提携関係になく、両社による承認や後援も受けていません。ClaudeおよびClaude Codeは、Anthropic, PBCの商標です。",
    quit: "終了",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple：ルーター停止中 — Claude Desktopは接続できません",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `プロキシ ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "ログイン時に起動",
    downNotifyTitle: "Claude Desktopが接続できません",
    starting: "ルーターを起動中…",
    open: "ClaudeRippleを開く…",
    directHeadline: "Claude の標準接続を使用中（Ripple はオフ）",
    tooltipDirect: "ClaudeRipple：Claude の標準接続を使用中",
    notifyDownTitle: "Ripple が応答しません",
    notifyDownBody: "現在 Claude は AI に接続できません。Ripple を修復するか、Claude の標準接続に切り替えられます。",
    actRepair: "修復",
    actDirectOn: "Claude の標準接続に切り替え",
    restartConfirm: "Claude アプリを終了して開き直しますか？",
    restartConfirmDetail: "Claude アプリで開いている会話や進行中の作業は止まります。",
    restartNow: "開き直す",
    setupNeeded: "セットアップ未完了",
    setupNeededDetail: "ClaudeRippleはインストール済みですが、まだセットアップされていません",
    runSetup: "ClaudeRippleのセットアップを完了…",
    claudeCurrent: "現在のログイン",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5時間",
    windowWeek: "週間",
    checkUpdates: "アップデートを確認…",
    updateAvailableItem: (v: string) => `ClaudeRipple ${v} にアップデート…`,
    upToDate: (v: string) => `ClaudeRipple ${v} は最新バージョンです。`,
    updateAvailable: (latest: string, current: string) => `ClaudeRipple ${latest} が利用可能です（現在のバージョン：${current}）。`,
    updateDetail: "処理中のリクエストが終わり次第、ルーターは新しいバージョンで再起動します。トレイアプリは自動で再起動します。",
    updateNow: "アップデート",
    later: "後で",
    updating: (v: string) => `ClaudeRipple ${v} にアップデート中…`,
    autoUpdated: (v: string) => `ClaudeRipple ${v} にアップデートしました。`,
    autoAvailable: (v: string) => `新しいバージョン ${v} が利用可能です。クリックしてアップデートしてください。`,
    updateDone: (v: string) => `ClaudeRipple ${v} へのアップデートが完了しました。`,
    updateFailed: "アップデートが完了しませんでした。",
    close: "閉じる",
    failureDetails: "詳細",
    failureOutput: "出力全文",
    failureOutputCopied: "出力全文（コピー済み）",
    copyOutput: "コピー",
    setupAgain: "セットアップを再実行",
    tryAgain: "再試行",
    routerRestarted: "ルーターを再起動しました",
    failures: failureText({
      "router-not-switched": ["ルーターが旧バージョンで実行中", "新しいバージョンはインストールされていますが、現在実行中のルーターは旧バージョンです。ルーターを再起動すると新しいバージョンに切り替わります。"],
      "router-not-started": ["ルーターが未起動", "ルーターを起動できませんでした。「修復」で起動項目を再登録し、ルーターを起動します。"],
      "startup-entry": ["起動項目の問題", "ログイン時にルーターを起動する項目を登録または実行できませんでした。「修復」でこの項目を再登録します。"],
      "certificate": ["証明書の問題", "ルーターのローカル証明書を読み取れなかったか、証明書が一致していません。セットアップを再実行してください。"],
      "router-unresponsive": ["ルーターが応答しません", "ルーターが最後の接続確認に応答しませんでした。他のプログラムがCPUを多く使用しているときによく起こります。少し待ってからセットアップを再実行してください。"],
      "anthropic-unreachable": ["Anthropicに接続できません", "ルーターは応答しましたが、Anthropicに接続できませんでした。インターネット接続を確認してから、セットアップを再実行してください。"],
      "foreign-proxy": ["別のプロキシを使用中", "Claude Codeが別のプロキシを使う設定になっているため、設定は変更していません。そのプロキシをオフにしてから、セットアップを再実行してください。"],
      "disk-full": ["ディスクの空き容量不足", "インストールに必要なディスクの空き容量がありません。空き容量を確保してから、再試行してください。"],
      "files-unwritable": ["ファイルを置き換えられませんでした", "インストール先フォルダーのファイルが使用中か、このアカウントに書き込み権限がありません。少し待ってから再試行してください。"],
      "download": ["ダウンロード失敗", "新しいバージョンをダウンロードできませんでした。インターネット接続を確認してから、再試行してください。"],
      "unknown": ["不明なエラー", "出力から既知の原因は見つかりませんでした。出力全文は「詳細」で確認できます。"],
    }),
    trayReplaceGaveUp: (v: string) => `トレイアプリを新しいバージョンに切り替えられませんでした。トレイアプリは ${v} バージョンのまま動作を続けます。詳しくはトレイのログで確認できます。`,
    updateCheckFailed: "アップデートを確認できませんでした。",
    updatePackaged: "これはスタンドアロン版のアプリです。リリースページから新しいバージョンをダウンロードしてください。",
    updateCheckout: "これはソースから実行している環境です。git pullで更新してください。",
    awakeMenu: (mode: string) => `ノートPC のスリープ防止 · ${mode}`,
    awakeOff: "オフ",
    awakeWorking: "作業中のみ",
    awakeOn: "常にオン",
    tetherItem: "Wi-Fi切断時にスマホのインターネット共有へ自動切替",
    laptopOpen: "ノートPC の管理を開く…",
    laptopSetup: "ノートPC の機能を設定…",
  },
  es: {
    healthy: "en buen estado",
    attentionNeeded: "requiere atención",
    routerNotRunning: "router detenido",
    slotsMapped: (n: number) => `${n} ${n === 1 ? "slot asignado" : "slots asignados"}`,
    inFlight: "en curso",
    connected: "Claude Desktop conectado",
    notConnected: "Claude Desktop no conectado",
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "Reiniciar router",
    startRouter: "Iniciar router",
    pickerOn: "Mostrar GPT en el selector de Code…",
    pickerOff: "Ocultar GPT en el selector de modelos…",
    pickerState: (on: boolean): string => (on ? "Selector de modelos: modelos GPT con su nombre ✓" : "Selector de modelos: modelos GPT bajo nombres de Claude (modo alias)"),
    pickerOnConfirm: "macOS te pedirá tu contraseña de inicio de sesión para confiar en el certificado de ClaudeRipple (ClaudeRipple nunca la ve). Después, cierra Claude Desktop por completo y vuelve a abrirlo.",
    pickerDone: "Listo. Cierra Claude Desktop por completo, vuelve a abrirlo y revisa el selector de modelos de la pestaña Code.",
    pickerOffDone: "Listo. Cierra Claude Desktop por completo y vuelve a abrirlo para aplicarlo.",
    cancel: "Cancelar",
    agentTitleOn: "Mostrar nombres de modelo en los subagentes",
    agentTitleOff: "Dejar de mostrar nombres de modelo en los subagentes",
    agentTitleDone: (on: boolean): string => (on ? "Activado. Los subagentes nuevos tendrán títulos como \"Terra·high · …\"." : "Desactivado."),
    signInChatgpt: "Iniciar sesión en ChatGPT…",
    connectClaudeSubscription: "Conectar suscripción de Claude…",
    copyStatus: "Copiar estado",
    showLogs: "Mostrar registros",
    rerunSetup: "Volver a ejecutar la configuración de ClaudeRipple…",
    setupTitle: "Configurar ClaudeRipple",
    setupPrompt: "ClaudeRipple creará un certificado local, conectará la configuración de Claude Code (~/.claude/settings.json) y registrará el router en segundo plano. ¿Continuar?",
    setupLater: "Más tarde",
    setupContinue: "Continuar",
    setupDone: "Configuración de ClaudeRipple completada.",
    setupFailed: "La configuración de ClaudeRipple no se completó.",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `El router en ejecución está en la versión ${from}. Cambiándolo a esta versión…`,
    updatedFailed: "No se pudo cambiar el router a la nueva versión.",
    problem: (code: string) =>
      code === "settings" ? "Claude Code no apunta a ClaudeRipple"
      : code === "upstream" ? "No se puede acceder a Anthropic"
      : code === "picker-ca" ? "modo selector: el certificado no es de confianza"
      : code === "picker-proxy" ? "modo selector: proxy de Claude Desktop sin configurar"
      : code === "config" ? "el archivo de ajustes tiene errores"
      : code.startsWith("provider:") ? `no se puede acceder al proveedor ${code.slice(9)}`
      : code,
    about: "Acerca de ClaudeRipple",
    aboutDetail:
      "Usa GPT y muchos otros modelos junto con Claude sin salir de Claude Desktop.\n\nProyecto independiente de código abierto (GPL-3.0). No está afiliado a Anthropic ni a OpenAI, ni cuenta con su respaldo ni con su patrocinio. Claude y Claude Code son marcas comerciales de Anthropic, PBC.",
    quit: "Salir",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: router detenido — Claude Desktop no puede conectarse",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "Abrir al iniciar sesión",
    downNotifyTitle: "Claude Desktop no puede conectarse",
    starting: "iniciando el router…",
    open: "Abrir ClaudeRipple…",
    directHeadline: "Conexión predeterminada de Claude (Ripple apagado)",
    tooltipDirect: "ClaudeRipple: usando la conexión predeterminada de Claude",
    notifyDownTitle: "Ripple no responde",
    notifyDownBody: "Claude no puede conectarse a la IA ahora mismo. Repara Ripple o usa la conexión predeterminada de Claude.",
    actRepair: "Reparar",
    actDirectOn: "Usar la conexión predeterminada de Claude",
    restartConfirm: "¿Cerrar y volver a abrir la app de Claude?",
    restartConfirmDetail: "Las conversaciones abiertas y el trabajo en curso en la app de Claude se detendrán.",
    restartNow: "Reabrir",
    setupNeeded: "configuración pendiente",
    setupNeededDetail: "ClaudeRipple está instalado, pero aún no está configurado",
    runSetup: "Terminar de configurar ClaudeRipple…",
    claudeCurrent: "sesión actual",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5 h",
    windowWeek: "semanal",
    checkUpdates: "Buscar actualizaciones…",
    updateAvailableItem: (v: string) => `Actualizar a ClaudeRipple ${v}…`,
    upToDate: (v: string) => `ClaudeRipple ${v} es la última versión.`,
    updateAvailable: (latest: string, current: string) => `ClaudeRipple ${latest} está disponible (tienes la ${current}).`,
    updateDetail: "El router se reinicia con la nueva versión cuando terminan todas las solicitudes en curso. La app de la bandeja se vuelve a abrir sola.",
    updateNow: "Actualizar",
    later: "Más tarde",
    updating: (v: string) => `Actualizando a ClaudeRipple ${v}…`,
    autoUpdated: (v: string) => `ClaudeRipple se actualizó a la versión ${v}.`,
    autoAvailable: (v: string) => `La versión ${v} está disponible. Haz clic para actualizar.`,
    updateDone: (v: string) => `Se completó la actualización a ClaudeRipple ${v}.`,
    updateFailed: "La actualización no se completó.",
    close: "Cerrar",
    failureDetails: "Detalles",
    failureOutput: "Salida completa",
    failureOutputCopied: "Salida completa (copiada)",
    copyOutput: "Copiar",
    setupAgain: "Volver a ejecutar la configuración",
    tryAgain: "Reintentar",
    routerRestarted: "Router reiniciado",
    failures: failureText({
      "router-not-switched": ["El router sigue en la versión anterior", "La nueva versión está instalada, pero el router en ejecución sigue en la anterior. Reinicia el router para que use la nueva versión."],
      "router-not-started": ["Router no iniciado", "No se pudo iniciar el router. «Reparar» vuelve a registrar su entrada de inicio y lo inicia."],
      "startup-entry": ["Problema con la entrada de inicio", "No se pudo registrar o ejecutar la entrada que inicia el router al iniciar sesión. «Reparar» vuelve a registrarla."],
      "certificate": ["Problema con el certificado", "No se pudo leer el certificado local del router o el certificado no coincide. Vuelve a ejecutar la configuración."],
      "router-unresponsive": ["El router no responde", "El router no respondió a la comprobación final de conexión. Esto suele ocurrir cuando otros programas mantienen la CPU ocupada. Vuelve a ejecutar la configuración dentro de un momento."],
      "anthropic-unreachable": ["No se puede acceder a Anthropic", "El router respondió, pero no pudo acceder a Anthropic. Comprueba tu conexión a internet y vuelve a ejecutar la configuración."],
      "foreign-proxy": ["Otro proxy en uso", "Claude Code está configurado para usar otro proxy, por lo que no se modificaron sus ajustes. Desactiva ese proxy y vuelve a ejecutar la configuración."],
      "disk-full": ["Disco lleno", "No hay suficiente espacio en disco para la instalación. Libera espacio y vuelve a intentarlo."],
      "files-unwritable": ["No se pudieron reemplazar los archivos", "Los archivos de la carpeta de instalación están en uso o esta cuenta no tiene permiso para escribir en ellos. Vuelve a intentarlo dentro de un momento."],
      "download": ["Error de descarga", "No se pudo descargar la nueva versión. Comprueba tu conexión a internet y vuelve a intentarlo."],
      "unknown": ["Error desconocido", "No se encontró ninguna causa conocida en la salida. La salida completa está en «Detalles»."],
    }),
    trayReplaceGaveUp: (v: string) => `La app de la bandeja no pudo cambiar a la nueva versión y sigue en la versión ${v}. Puedes ver los detalles en el registro de la bandeja.`,
    updateCheckFailed: "No se pudo comprobar si hay actualizaciones.",
    updatePackaged: "Esta es la app independiente. Descarga la nueva versión desde la página de versiones.",
    updateCheckout: "Esta es una copia del código fuente. Actualízala con git pull.",
    awakeMenu: (mode: string) => `Mantener el portátil despierto · ${mode}`,
    awakeOff: "No",
    awakeWorking: "Solo mientras trabaja",
    awakeOn: "Siempre",
    tetherItem: "Punto de acceso móvil sin Wi-Fi (auto)",
    laptopOpen: "Abrir Portátil…",
    laptopSetup: "Configurar funciones del portátil…",
  },
  pt: {
    healthy: "funcionando",
    attentionNeeded: "requer atenção",
    routerNotRunning: "roteador parado",
    slotsMapped: (n: number) => `${n} slot${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}`,
    inFlight: "em andamento",
    connected: "Claude Desktop conectado",
    notConnected: "Claude Desktop não conectado",
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "Reiniciar roteador",
    startRouter: "Iniciar roteador",
    pickerOn: "Mostrar GPT no seletor da aba Code…",
    pickerOff: "Ocultar GPT no seletor de modelos…",
    pickerState: (on: boolean): string => (on ? "Seletor de modelos: modelos GPT exibidos pelo nome ✓" : "Seletor de modelos: modelos GPT via nomes do Claude (modo alias)"),
    pickerOnConfirm: "O macOS vai pedir sua senha de login para confiar no certificado do ClaudeRipple (o ClaudeRipple nunca a vê). Depois, encerre o Claude Desktop por completo e abra-o de novo.",
    pickerDone: "Pronto. Encerre o Claude Desktop por completo, abra-o de novo e confira o seletor de modelos da aba Code.",
    pickerOffDone: "Pronto. Encerre o Claude Desktop por completo e abra-o de novo para aplicar.",
    cancel: "Cancelar",
    agentTitleOn: "Mostrar nomes de modelo nos subagentes",
    agentTitleOff: "Parar de mostrar nomes de modelo nos subagentes",
    agentTitleDone: (on: boolean): string => (on ? "Ativado. Novos subagentes terão títulos como \"Terra·high · …\"." : "Desativado."),
    signInChatgpt: "Entrar no ChatGPT…",
    connectClaudeSubscription: "Conectar assinatura do Claude…",
    copyStatus: "Copiar status",
    showLogs: "Mostrar logs",
    rerunSetup: "Configurar o ClaudeRipple novamente…",
    setupTitle: "Configurar o ClaudeRipple",
    setupPrompt: "O ClaudeRipple vai criar um certificado local, conectar as configurações do Claude Code (~/.claude/settings.json) e registrar o roteador em segundo plano. Continuar?",
    setupLater: "Depois",
    setupContinue: "Continuar",
    setupDone: "Configuração do ClaudeRipple concluída.",
    setupFailed: "A configuração do ClaudeRipple não foi concluída.",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `O roteador em execução está na versão ${from}. Mudando para esta versão…`,
    updatedFailed: "Não foi possível mudar o roteador para a nova versão.",
    problem: (code: string) =>
      code === "settings" ? "O Claude Code não está configurado para usar o ClaudeRipple"
      : code === "upstream" ? "A Anthropic está inacessível"
      : code === "picker-ca" ? "modo seletor: certificado não confiável"
      : code === "picker-proxy" ? "modo seletor: proxy do Claude Desktop não configurado"
      : code === "config" ? "o arquivo de configuração tem erros"
      : code.startsWith("provider:") ? `provedor ${code.slice(9)} inacessível`
      : code,
    about: "Sobre o ClaudeRipple",
    aboutDetail:
      "Use o GPT e vários outros modelos junto com o Claude, sem sair do Claude Desktop.\n\nProjeto open source independente (GPL-3.0). Não tem afiliação com a Anthropic nem com a OpenAI, nem é endossado ou patrocinado por nenhuma delas. Claude e Claude Code são marcas comerciais da Anthropic, PBC.",
    quit: "Sair",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: roteador parado — o Claude Desktop não consegue se conectar",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "Iniciar ao fazer login",
    downNotifyTitle: "O Claude Desktop não consegue se conectar",
    starting: "iniciando o roteador…",
    open: "Abrir o ClaudeRipple…",
    directHeadline: "Conexão padrão do Claude (Ripple desligado)",
    tooltipDirect: "ClaudeRipple: usando a conexão padrão do Claude",
    notifyDownTitle: "O Ripple não está respondendo",
    notifyDownBody: "O Claude não consegue acessar a IA agora. Repare o Ripple ou use a conexão padrão do Claude.",
    actRepair: "Reparar",
    actDirectOn: "Usar a conexão padrão do Claude",
    restartConfirm: "Encerrar e reabrir o app do Claude?",
    restartConfirmDetail: "As conversas abertas e o trabalho em andamento no app do Claude vão parar.",
    restartNow: "Reabrir",
    setupNeeded: "configuração não concluída",
    setupNeededDetail: "O ClaudeRipple está instalado, mas ainda não foi configurado",
    runSetup: "Concluir a configuração do ClaudeRipple…",
    claudeCurrent: "login atual",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5h",
    windowWeek: "semanal",
    checkUpdates: "Verificar atualizações…",
    updateAvailableItem: (v: string) => `Atualizar para o ClaudeRipple ${v}…`,
    upToDate: (v: string) => `O ClaudeRipple ${v} é a versão mais recente.`,
    updateAvailable: (latest: string, current: string) => `O ClaudeRipple ${latest} está disponível (você tem a ${current}).`,
    updateDetail: "O roteador reinicia na nova versão assim que todas as requisições em andamento terminarem. O app da bandeja reabre sozinho.",
    updateNow: "Atualizar",
    later: "Depois",
    updating: (v: string) => `Atualizando para o ClaudeRipple ${v}…`,
    autoUpdated: (v: string) => `O ClaudeRipple foi atualizado para a versão ${v}.`,
    autoAvailable: (v: string) => `A versão ${v} está disponível. Clique para atualizar.`,
    updateDone: (v: string) => `A atualização para o ClaudeRipple ${v} foi concluída.`,
    updateFailed: "A atualização não foi concluída.",
    close: "Fechar",
    failureDetails: "Detalhes",
    failureOutput: "Saída completa",
    failureOutputCopied: "Saída completa (copiada)",
    copyOutput: "Copiar",
    setupAgain: "Configurar novamente",
    tryAgain: "Tentar novamente",
    routerRestarted: "Roteador reiniciado",
    failures: failureText({
      "router-not-switched": ["Roteador ainda na versão anterior", "A nova versão está instalada, mas o roteador em execução ainda está na versão anterior. Reiniciar o roteador faz com que ele use a nova versão."],
      "router-not-started": ["Roteador não iniciado", "Não foi possível iniciar o roteador. “Reparar” registra novamente a entrada de inicialização e inicia o roteador."],
      "startup-entry": ["Problema na entrada de inicialização", "Não foi possível registrar ou executar a entrada que inicia o roteador ao fazer login. “Reparar” registra essa entrada novamente."],
      "certificate": ["Problema no certificado", "Não foi possível ler o certificado local do roteador ou o certificado não corresponde. Execute a configuração novamente."],
      "router-unresponsive": ["O roteador não está respondendo", "O roteador não respondeu à verificação final de conexão. Isso costuma acontecer quando outros programas mantêm a CPU ocupada. Execute a configuração novamente daqui a pouco."],
      "anthropic-unreachable": ["A Anthropic está inacessível", "O roteador respondeu, mas não conseguiu acessar a Anthropic. Verifique sua conexão com a internet e execute a configuração novamente."],
      "foreign-proxy": ["Outro proxy em uso", "O Claude Code está configurado para usar outro proxy, por isso suas configurações não foram alteradas. Desative esse proxy e execute a configuração novamente."],
      "disk-full": ["Disco cheio", "Não há espaço suficiente em disco para instalar. Libere espaço e tente novamente."],
      "files-unwritable": ["Não foi possível substituir os arquivos", "Os arquivos na pasta de instalação estão em uso ou esta conta não tem permissão para gravar neles. Tente novamente daqui a pouco."],
      "download": ["Falha no download", "Não foi possível baixar a nova versão. Verifique sua conexão com a internet e tente novamente."],
      "unknown": ["Erro desconhecido", "Nenhuma causa conhecida foi encontrada na saída. A saída completa está em “Detalhes”."],
    }),
    trayReplaceGaveUp: (v: string) => `O app da bandeja não pôde mudar para a nova versão e continua na versão ${v}. Veja os detalhes no log da bandeja.`,
    updateCheckFailed: "Não foi possível verificar atualizações.",
    updatePackaged: "Este é o app independente. Baixe a nova versão na página de releases.",
    updateCheckout: "Isto é um checkout do código-fonte. Atualize com git pull.",
    awakeMenu: (mode: string) => `Manter o notebook acordado · ${mode}`,
    awakeOff: "Não",
    awakeWorking: "Só enquanto trabalha",
    awakeOn: "Sempre",
    tetherItem: "Acesso Pessoal sem Wi-Fi (automático)",
    laptopOpen: "Abrir Notebook…",
    laptopSetup: "Configurar recursos do notebook…",
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
/** The laptop settings, read with each healthy poll; null when the router has none to offer. */
let power: Power | null = null;
let lastError: string | null = null;
let starting = false;
let downSince: number | null = null;
let downNotified = false;
/** Whether the last health poll got an answer; null before the first poll. */
let answered: boolean | null = null;
// Long enough that a router still coming up after login does not fire a notification.
const DOWN_NOTIFY_AFTER_MS = 20_000;

// ---- login item ------------------------------------------------------------------------
// The tray app has to be running before the user opens Claude Desktop: with the router down the
// app shows nothing but ERR_PROXY_CONNECTION_FAILED, and the tray is the only place that says why.

const stateFile = path.join(home, "app.json");

type SavedAppState = { loginItemInitialized?: boolean; window?: Bounds };

function appState(): SavedAppState {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as SavedAppState;
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

/**
 * How Windows starts this tray at login. A packaged app is its own binary. Installed from npm, the
 * binary is a bare Electron that needs our script after it: registered without one, every logon
 * opened Electron's default app and no tray (issue #50). macOS ignores `path`/`args`.
 */
function loginItemLaunch(): { path: string; args: string[] } | undefined {
  if (app.isPackaged || process.platform !== "win32" || !process.argv[1]) return undefined;
  return { path: process.execPath, args: [path.resolve(process.argv[1])] };
}

let trayAgentOn = false;

function usesTrayAgent(): boolean {
  return process.platform === "darwin" && !app.isPackaged;
}

function loginItemOn(): boolean {
  if (usesTrayAgent()) return trayAgentOn;
  try {
    return app.getLoginItemSettings(loginItemLaunch()).openAtLogin;
  } catch {
    return false;
  }
}

/** Keep launchd's paths and plist definition in the CLI, not in the separately built Electron app. */
async function changeTrayAgent(mode: "on" | "off" | "init", flags: string[] = []): Promise<{ removeElectronItem: boolean }> {
  const result = await runCliResult(["tray", "--login", mode, ...flags], 15_000);
  const state = parseJsonOutput<{ on: boolean; removeElectronItem: boolean }>(result.stdout);
  if (!result.ok || typeof state?.on !== "boolean" || typeof state.removeElectronItem !== "boolean") throw new Error(result.output || "invalid tray login item response");
  trayAgentOn = state.on;
  return state;
}

async function setLoginItem(on: boolean): Promise<void> {
  try {
    if (usesTrayAgent()) await changeTrayAgent(on ? "on" : "off");
    else app.setLoginItemSettings({ openAtLogin: on, ...loginItemLaunch() });
    writeAppState({ loginItemInitialized: true });
  } catch (error) {
    console.error(`ClaudeRipple login item could not be changed: ${error}`);
  }
  render();
}

async function initializeLoginItem(): Promise<void> {
  const initialized = !!appState().loginItemInitialized;
  if (usesTrayAgent()) {
    const electronOpen = app.getLoginItemSettings().openAtLogin;
    // Remember the migration until the agent write succeeds, so a failed CLI can retry next start.
    if (electronOpen) writeAppState({ loginItemInitialized: false });
    let removeElectronItem = electronOpen;
    try {
      const decision = await changeTrayAgent("init", [...(initialized ? ["--initialized"] : []), ...(electronOpen ? ["--electron-login"] : [])]);
      removeElectronItem = decision.removeElectronItem;
      writeAppState({ loginItemInitialized: true });
    } finally {
      // Even if the agent write fails, never leave bare Electron registered for the next login.
      if (removeElectronItem) app.setLoginItemSettings({ openAtLogin: false });
    }
    return;
  }
  if (!initialized) await setLoginItem(true);
  // Windows entries from older versions omitted the tray script.
  else if (loginItemLaunch() && app.getLoginItemSettings().openAtLogin && !loginItemOn()) await setLoginItem(true);
}

// Overrides for running this app against stand-ins instead of the real installation (tests, and
// trying a change without touching the router someone depends on):
//   CLAUDERIPPLE_APP_ADMIN_URL  the admin API base the health poll and the dashboard use
//   CLAUDERIPPLE_APP_CLI        a CLI script to run instead of the installed one
//   CLAUDERIPPLE_APP_USER_DATA  Electron's data folder, which also keys the one-tray lock
// CLAUDERIPPLE_HOME (logs, app.json, config.json) is honoured as everywhere else.
function adminUrl(): string {
  const override = process.env.CLAUDERIPPLE_APP_ADMIN_URL;
  if (override) return override.endsWith("/") ? override : `${override}/`;
  return `http://127.0.0.1:${readConfigPorts().admin}/`;
}

/**
 * The language the user actually set in the OS. `app.getLocale()` is Chromium's app locale and
 * reads `en-US` on a Korean Windows (measured 2026-09-14), so the tray, notifications and the GUI
 * came up in English there. macOS happened to agree, which hid it.
 */
function uiLang(): keyof typeof STRINGS {
  const candidates = [...app.getPreferredSystemLanguages(), app.getSystemLocale(), app.getLocale()];
  const first = candidates.find((l) => typeof l === "string" && l.length > 0) ?? "en";
  // Every Chinese locale gets the Simplified text and every Portuguese one the Brazilian text.
  const base = first.toLowerCase().split(/[-_]/)[0]!;
  return base in STRINGS ? (base as keyof typeof STRINGS) : "en";
}

async function poll(): Promise<void> {
  const before = answered;
  try {
    const res = await fetch(`${adminUrl()}api/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    last = (await res.json()) as Status;
    lastError = null;
    downSince = null;
    downNotified = false;
    answered = true;
    void handleRouterUpdate(last).catch((error: unknown) => console.error(`update notification: ${error}`));
    void reconcileRouter(last);
    power = await readPower();
  } catch (e) {
    last = null;
    power = null;
    lastError = (e as Error).message;
    answered = false;
    downSince ??= Date.now();
    // An update or one of the window's own actions restarts the router on purpose; that is not
    // the outage the notification is for. Neither is the direct mode, where the router being off
    // is the point — so doctor is asked first, and once per outage. With the window on screen the
    // user is already looking at the same news.
    if (shouldNotifyDown({ downForMs: Date.now() - downSince, graceMs: DOWN_NOTIFY_AFTER_MS, alreadyNotified: downNotified, updating: updating || Date.now() < routerUpdateUntil, busy: !!rec.busy || windowVisible(), mode: rec.doctor?.mode ?? null })) {
      downNotified = true;
      void refreshDoctor().then(() => {
        if (!last && rec.doctor?.mode !== "direct") notifyDown();
      });
    }
  }
  // Up or down changed: what doctor said about the rest (direct, mixed) may have changed with it.
  if (before !== null && before !== answered && !rec.busy) void refreshDoctor();
  // Claude quit or reopened by hand has applied the change as surely as the button would.
  if (rec.restartClaude && !rec.busy && Date.now() - restartCheckedAt >= RESTART_CHECK_MS) {
    restartCheckedAt = Date.now();
    if (!restartStillOwed(restartOwedSince, await claudeStartedAt())) rec.restartClaude = false;
  }
  render();
}

/** The laptop settings for the tray, or null: a router without them (501), Linux, or a failed read. */
async function readPower(): Promise<Power | null> {
  try {
    const res = await fetch(`${adminUrl()}api/power`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const p = (await res.json()) as Power;
    return p.awake?.setup === "unsupported" ? null : p;
  } catch {
    return null;
  }
}

/** Saves one laptop setting through the router (the same PUT the dashboard sends), then redraws. */
async function changePower(change: { awake?: { mode: AwakeMode; until: null }; tether?: { enabled: boolean } }): Promise<void> {
  try {
    const res = await fetch(`${adminUrl()}api/power`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) power = (await res.json()) as Power;
    else console.error(`power change: HTTP ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(`power change: ${(e as Error).message}`);
  }
  render();
}

// Held so the handlers are not collected with it before the user gets to the notification.
let downNotification: Notification | null = null;

/** The router being down means Claude is silent, so say so out loud, with the two ways out. */
function notifyDown(): void {
  if (!Notification.isSupported()) {
    // Nothing else would tell the user; the window does.
    showWindow("health");
    return;
  }
  const n = new Notification({
    title: L.notifyDownTitle,
    body: L.notifyDownBody,
    icon: notifyIcon(),
    // macOS shows these as buttons on the notification (an Options menu when there are two).
    actions: [
      { type: "button", text: L.actRepair },
      { type: "button", text: L.actDirectOn },
    ],
  });
  n.on("click", () => showWindow("health"));
  n.on("action", (_event, index) => {
    showWindow("health");
    void act(index === 0 ? "repair" : "direct-on");
  });
  n.show();
  downNotification = n;
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
  if (s.readiness) return s.readiness.ready ? "ok" : "warn";
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
function icon(state: "ok" | "warn" | "down" | "direct"): Electron.NativeImage {
  const mac = { ok: "trayTemplate.png", warn: "trayWarnTemplate.png", down: "trayDownTemplate.png", direct: "trayDirectTemplate.png" };
  const win = { ok: "trayWin.png", warn: "trayWinWarn.png", down: "trayWinDown.png", direct: "trayWinDirect.png" };
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", (isMac ? mac : win)[state]));
  if (isMac) img.setTemplateImage(true);
  return img;
}

/** The app icon on notifications: macOS uses the bundle's own; elsewhere Electron would show its default. */
function notifyIcon(): string | undefined {
  return isMac ? undefined : path.join(__dirname, "..", "assets", "icon.png");
}

/**
 * The dashboard window. It opens with the router down too (its page is the app's own), and then on
 * Status, where the way back is. Before setup there is no router to ask anything of, so the step
 * that is actually missing comes first.
 */
async function openDashboard(): Promise<void> {
  if (!last && needsSetup()) {
    await setup();
    await poll();
  }
  showWindow(last ? undefined : "health");
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
  const otherVersion = s.version !== trayVersion();
  if (!installedElsewhere && !runningElsewhere && !otherVersion) return;
  reconciled = true;
  const from = `${s.version}${s.runtime?.router ? ` (${s.runtime.router})` : ""}`;
  if (Notification.isSupported()) new Notification({ title: L.updatedTitle(trayVersion()), body: L.updatedRestarting(from), icon: notifyIcon() }).show();
  const outputs: string[] = [];
  if (installedElsewhere || runningElsewhere) outputs.push(await runCli(["install"]));
  outputs.push(await runCli(["restart"]));
  const out = outputs.join("\n\n");
  if (failedOutput(out)) await showFailure(L.updatedFailed, out);
  void poll();
}

/** Whether `install` or `restart` printed a failure; both mark a step that did not happen. */
function failedOutput(out: string): boolean {
  return /✗|error|failed|not restarted|start failed/i.test(out);
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
  const override = process.env.CLAUDERIPPLE_APP_CLI;
  if (override) return { node: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" }, cli: override };
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
  return runCliResult(args).then((r) => r.output);
}

/**
 * Runs the CLI without blocking anything. `stdout` is kept apart for the `--json` commands, whose
 * one object must not be mixed with warnings on stderr. With `timeoutMs` a CLI that hangs (a
 * supervisor that never answers) is ended rather than left holding a button down.
 */
function runCliResult(args: string[], timeoutMs = 0, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ ok: boolean; output: string; stdout: string; timedOut: boolean }> {
  const { node, env, cli } = cliPaths();
  return new Promise((resolve) => {
    // An update prints npm's and the installer's own lines; the default 1MB buffer is not for that.
    execFile(node, [cli, ...args], { env: { ...process.env, ...env, CLAUDERIPPLE_HOME: home, ...extraEnv }, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const timedOut = !!err && timeoutMs > 0 && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      resolve({ ok: !err, output: `${stdout}${stderr}${err ? `\n${err.message}` : ""}`.trim(), stdout: String(stdout), timedOut });
    });
  });
}

// ---- recovery: doctor, repair, direct -----------------------------------------------------
// The CLI does the work and answers in JSON; this keeps what it last said and what is running,
// and hands both to the dashboard (window.rippleApp) to draw its connection card.

const ACTION_TIMEOUT_MS = 40_000;
const DOCTOR_TIMEOUT_MS = 15_000;
/** Background check, mainly to notice the direct mode while the router is still answering. */
const DOCTOR_EVERY_MS = 5 * 60_000;
/** While the window is open it should not show something a minute old. */
const DOCTOR_WHILE_OPEN_MS = 10_000;
const LOG_LINES = 40;

const rec: { doctor: Doctor | null; doctorFailed: boolean; busy: Busy; result: ActionResult | null; restartClaude: boolean } = {
  doctor: null,
  doctorFailed: false,
  busy: null,
  result: null,
  restartClaude: false,
};
/** When the connection last changed in a way Claude only picks up on its next start. */
let restartOwedSince = 0;
let restartCheckedAt = 0;
/** How often a pending "reopen Claude" step asks whether Claude was reopened some other way. */
const RESTART_CHECK_MS = 15_000;
let doctorRun: Promise<void> | null = null;

/** One `doctor` at a time; callers that arrive while one runs share it. */
function refreshDoctor(): Promise<void> {
  doctorRun ??= (async () => {
    const r = await runCliResult(["doctor", "--json"], DOCTOR_TIMEOUT_MS);
    const d = parseJsonOutput<Doctor>(r.stdout);
    rec.doctor = d;
    rec.doctorFailed = !d;
  })().finally(() => {
    doctorRun = null;
    render();
  });
  return doctorRun;
}

/** The end of router.log, read from disk: it is there to look at precisely when the router is not. */
function logTail(): string[] {
  const file = path.join(home, "logs", "router.log");
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 16 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      return tailLines(buf.toString("utf8"), LOG_LINES).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** What the dashboard's connection card is drawn from. */
function bridgeState(): AppState {
  return {
    doctor: rec.doctor,
    doctorFailed: rec.doctorFailed,
    routerAnswering: answered,
    busy: rec.busy,
    result: rec.result,
    restartClaude: rec.restartClaude,
    loginItem: loginItemOn(),
    appVersion: trayVersion(),
    platform: process.platform,
  };
}

let lastSent = "";
/** Tells the open window, if any, when the state changed (render() runs on every poll). */
function pushState(): void {
  if (!mainWindow()) return;
  const state = bridgeState();
  const key = JSON.stringify(state);
  if (key === lastSent) return;
  lastSent = key;
  sendToWindow("ripple-app:state", state);
}

function showWindow(view?: string): void {
  openWindow(
    {
      lang: uiLang(),
      savedBounds: () => appState().window ?? null,
      saveBounds: (bounds) => writeAppState({ window: bounds }),
      shown: () => {
        lastSent = "";
        if (!rec.busy) void refreshDoctor();
      },
    },
    view,
  );
}

type BridgeAction = Action | "refresh" | "login-item" | "logs";
const BRIDGE_ACTIONS = new Set<string>(["repair", "direct-on", "direct-off", "restart-claude", "refresh", "login-item", "logs"]);

/** Only our own page may drive the bridge, never something it navigated to. */
function fromOurPage(event: Electron.IpcMainInvokeEvent): boolean {
  return (event.senderFrame?.url ?? "").startsWith(`${ORIGIN}/`);
}

function wireBridge(): void {
  ipcMain.handle("ripple-app:state", (event) => (fromOurPage(event) ? bridgeState() : null));
  ipcMain.handle("ripple-app:log", (event) => (fromOurPage(event) ? logTail() : []));
  ipcMain.handle("ripple-app:act", async (event, id: unknown) => {
    if (!fromOurPage(event) || typeof id !== "string" || !BRIDGE_ACTIONS.has(id)) return null;
    await act(id as BridgeAction);
    return bridgeState();
  });
}

async function act(id: BridgeAction): Promise<void> {
  switch (id) {
    case "repair":
      return runAction("repair", ["repair", "--json"]);
    case "direct-on":
      return runAction("direct-on", ["direct", "on", "--json"]);
    case "direct-off":
      return runAction("direct-off", ["direct", "off", "--json"]);
    case "restart-claude":
      return restartClaude();
    case "logs":
      fs.mkdirSync(path.join(home, "logs"), { recursive: true });
      void shell.openPath(path.join(home, "logs"));
      return;
    case "refresh":
      if (rec.busy) return;
      rec.busy = "checking";
      render();
      await Promise.all([poll(), refreshDoctor()]);
      rec.busy = null;
      render();
      return;
    case "login-item":
      await setLoginItem(true);
      render();
      return;
  }
}

async function runAction(action: "repair" | "direct-on" | "direct-off", args: string[]): Promise<void> {
  if (rec.busy) return;
  rec.busy = action;
  rec.result = null;
  render();
  const r = await runCliResult(args, ACTION_TIMEOUT_MS);
  const out = parseJsonOutput<RepairOutput & DirectOutput>(r.stdout);
  const ok = !r.timedOut && out?.ok === true;
  const details =
    action === "repair"
      ? repairDetails(out, r.output)
      : [out?.detail ?? "", ...(ok ? [] : tailLines(out ? "" : r.output, 8))].filter(Boolean);
  rec.result = { action, ok, timedOut: r.timedOut, details, at: Date.now() };
  if (ok && out?.restartClaude) {
    // A Claude that is not running picks the change up when it next starts: nothing to ask for.
    restartOwedSince = Date.now();
    rec.restartClaude = restartStillOwed(restartOwedSince - 1, await claudeStartedAt());
  }
  if (out?.doctor) {
    rec.doctor = out.doctor;
    rec.doctorFailed = false;
  }
  rec.busy = null;
  await poll();
  if (!out?.doctor) await refreshDoctor();
  render();
}

async function restartClaude(): Promise<void> {
  if (rec.busy) return;
  const options: Electron.MessageBoxOptions = {
    type: "question",
    message: L.restartConfirm,
    detail: L.restartConfirmDetail,
    buttons: [L.restartNow, L.cancel],
    defaultId: 0,
    cancelId: 1,
  };
  const parent = mainWindow();
  const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (choice.response !== 0) return;
  rec.busy = "restart-claude";
  rec.result = null;
  render();
  const ok = await reopenClaude();
  rec.busy = null;
  rec.result = { action: "restart-claude", ok, details: [], at: Date.now() };
  if (ok) rec.restartClaude = false;
  render();
}

// ---- updates ----------------------------------------------------------------------------
// The tray asks `clauderipple update --check` at start and twice a day, and offers the update in
// the menu once there is one; "Check for Updates…" asks on demand (#39). The CLI does the work —
// it knows how this copy was installed — and restarts the router; the tray then starts a fresh
// tray from the new files and quits, since the process running now still holds the old code.

type UpdateCheck = { current: string; latest: string | null; newer: boolean; kind: string };
let availableUpdate: UpdateCheck | null = null;
let updating = false;
const UPDATE_CHECK_MS = 12 * 60 * 60 * 1000;
let routerUpdateUntil = 0;
let updateNotification: Notification | null = null;
let updateSeen: UpdateSeen | undefined;
const trayReplacement = new TrayReplacement();
const updateSeenFile = path.join(home, "update-notifications.json");
const replacementTriesFile = path.join(home, "tray-replacement.json");
let replacementGaveUp = false;

function loadUpdateSeen(): UpdateSeen {
  try { return readUpdateSeen(JSON.parse(fs.readFileSync(updateSeenFile, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`update notification state: ${error}`);
    return { updated: [], available: [] };
  }
}

function loadReplacementTries(): ReplacementTries | null {
  try { return readReplacementTries(JSON.parse(fs.readFileSync(replacementTriesFile, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`tray replacement state: ${error}`);
    return null;
  }
}

function saveReplacementTries(tries: ReplacementTries): void {
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${replacementTriesFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(tries) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, replacementTriesFile);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function relaunchTray(): Promise<void> {
  // The replacement starts as this one did: the CLI's own `tray` opens the window, which brought a
  // hidden dashboard to the front after every automatic update (B14). A window that was up stays up.
  const visible = windowVisible();
  app.releaseSingleInstanceLock();
  try {
    const result = await runCliResult(["tray", "--at-login"], 30_000, visible ? { CLAUDERIPPLE_APP_SHOW: "1" } : {});
    if (!result.ok) throw new Error(result.output || "could not relaunch tray");
  } catch (error) {
    // Keep a functioning tray if its replacement could not start, including spawn/timeout failures.
    if (!app.requestSingleInstanceLock()) app.quit();
    throw error;
  }
  app.quit();
}

async function handleRouterUpdate(status: Status): Promise<void> {
  if (status.autoUpdate?.running) routerUpdateUntil = Date.now() + 10 * 60_000;
  else routerUpdateUntil = 0;
  if (updating) return;
  updateSeen ??= loadUpdateSeen();
  const notice = updateNotice(status.version, trayVersion(), status.autoUpdate, updateSeen);
  if (!notice) {
    await replaceUpdatedTray(status);
    return;
  }
  // Notification delivery history is independent of replacement success.
  updateSeen = rememberUpdate(updateSeen, notice);
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${updateSeenFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(updateSeen) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, updateSeenFile);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (notice.kind === "available") {
    const check: UpdateCheck = { current: status.version, latest: notice.version, newer: true, kind: status.autoUpdate?.kind ?? "unknown" };
    availableUpdate = check;
    if (Notification.isSupported()) {
      updateNotification = new Notification({ title: "ClaudeRipple", body: L.autoAvailable(notice.version), icon: notifyIcon() });
      updateNotification.on("click", () => { void offerUpdate(check).catch((error: unknown) => console.error(`offer update: ${error}`)); });
      updateNotification.show();
    }
    return;
  }
  if (Notification.isSupported()) {
    updateNotification = new Notification({ title: "ClaudeRipple", body: L.autoUpdated(notice.version), icon: notifyIcon() });
    updateNotification.show();
  }
  await replaceUpdatedTray(status);
}

async function replaceUpdatedTray(status: Status): Promise<void> {
  const version = trayVersion();
  // A replacement that starts but does not change the tray's version — this is what a wrong
  // app.getVersion() looked like — came back as the same pair on every launch. Nothing could stop
  // it inside one process, because each attempt ends the process, so the count lives on disk:
  // after REPLACEMENT_LIMIT launches of the same pair the tray stays up and says why.
  if (replacementExhausted(loadReplacementTries(), status.version, version)) {
    if (!replacementGaveUp) {
      replacementGaveUp = true;
      console.error(`tray replacement gave up after ${REPLACEMENT_LIMIT} launches: router ${status.version}, tray ${version}`);
      if (Notification.isSupported()) new Notification({ title: "ClaudeRipple", body: L.trayReplaceGaveUp(version), icon: notifyIcon() }).show();
    }
    return;
  }
  await trayReplacement.reconcile(status.version, version, status.autoUpdate, async () => {
    saveReplacementTries(nextReplacementTries(loadReplacementTries(), status.version, version));
    updating = true;
    try { await relaunchTray(); } finally { updating = false; }
  });
}

async function checkForUpdate(): Promise<UpdateCheck | null> {
  const r = await runCliResult(["update", "--check", "--json"]);
  try {
    const check = JSON.parse(r.output.split("\n").pop() ?? "") as UpdateCheck;
    availableUpdate = check.newer ? check : null;
    render();
    return check;
  } catch {
    return null;
  }
}

async function checkUpdatesInteractive(): Promise<void> {
  const check = await checkForUpdate();
  if (!check) {
    await dialog.showMessageBox({ type: "warning", message: L.updateCheckFailed });
    return;
  }
  if (!check.newer) {
    await dialog.showMessageBox({ message: L.upToDate(check.current) });
    return;
  }
  await offerUpdate(check);
}

async function offerUpdate(check: UpdateCheck): Promise<void> {
  if (check.kind === "packaged") {
    const choice = await dialog.showMessageBox({ message: L.updateAvailable(check.latest ?? "?", check.current), detail: L.updatePackaged, buttons: [L.updateNow, L.later], defaultId: 0, cancelId: 1 });
    if (choice.response === 0) void shell.openExternal("https://github.com/PBJ-2/clauderipple/releases/latest");
    return;
  }
  if (check.kind === "checkout") {
    await dialog.showMessageBox({ message: L.updateAvailable(check.latest ?? "?", check.current), detail: L.updateCheckout });
    return;
  }
  const choice = await dialog.showMessageBox({ message: L.updateAvailable(check.latest ?? "?", check.current), detail: L.updateDetail, buttons: [L.updateNow, L.later], defaultId: 0, cancelId: 1 });
  if (choice.response !== 0) return;
  await installUpdate(check.latest ?? "");
}

/** The update the person chose, or chose to try again from its failure dialog. */
async function installUpdate(version: string): Promise<void> {
  if (updating) return;
  updating = true;
  render();
  if (Notification.isSupported()) new Notification({ title: "ClaudeRipple", body: L.updating(version), icon: notifyIcon() }).show();
  const retry = () => installUpdate(version);
  if (last?.autoUpdate) {
    // Share the router's coordinator with its scheduler instead of racing a second installer.
    let failure: string | null = null;
    try {
      const response = await fetch(`${adminUrl()}api/update`, { method: "POST", signal: AbortSignal.timeout(35_000) });
      if (!response.ok) throw new Error(await response.text());
      routerUpdateUntil = Date.now() + 10 * 60_000;
    } catch (error) {
      failure = String(error);
    } finally { updating = false; render(); }
    // After `updating` is cleared, so that trying again from the dialog can start.
    if (failure !== null) await showFailure(L.updateFailed, failure, retry);
    return; // /api/status will confirm completion, notify and relaunch this tray.
  }
  const r = await runCliResult(["update"]);
  updating = false;
  if (!r.ok) {
    render();
    await showFailure(L.updateFailed, r.output, retry);
    return;
  }
  availableUpdate = null;
  if (Notification.isSupported()) new Notification({ title: "ClaudeRipple", body: L.updateDone(version), icon: notifyIcon() }).show();
  // A new tray from the new files, then this one goes.
  await relaunchTray();
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
  if (failed) await showFailure(L.setupFailed, out);
  else await dialog.showMessageBox({ type: "info", title: DIALOG_TITLE, message: L.setupDone });
  void poll();
}

// ---- failure dialogs --------------------------------------------------------------------
// A failed update, setup or router switch used to put the CLI's whole output in the dialog: npm's
// lines, every install step and the exit code, with the cause somewhere in the middle (2026-10-29).
// The dialog now names each failure the output shows (failure-model.ts), offers the tray's own fix
// for the first one that has one, and keeps the output behind Details, where it can be copied.

/** Without a title Windows shows Electron's name: the tray runs as `electron path/to/main.js`. */
const DIALOG_TITLE = "ClaudeRipple";

/** `retry` runs the failed operation again; only an update passes one. */
async function showFailure(message: string, output: string, retry?: () => Promise<void>): Promise<void> {
  const kinds = failureKinds(output);
  const runs: Partial<Record<FailureAction, () => Promise<void>>> = {
    restart: restartAfterFailure,
    repair: async () => {
      showWindow("health");
      await act("repair");
    },
    setup,
    ...(retry ? { retry } : {}),
  };
  const action = failureAction(kinds, new Set(Object.keys(runs) as FailureAction[]));
  const label: Record<FailureAction, string> = { restart: L.restartRouter, repair: L.actRepair, setup: L.setupAgain, retry: L.tryAgain };
  const buttons = [...(action ? [label[action]] : []), L.failureDetails, L.close];
  const details = buttons.length - 2;
  const close = buttons.length - 1;
  const detail = kinds.map((kind) => L.failures[kind].join("\n")).join("\n\n");
  for (;;) {
    const choice = await dialog.showMessageBox({ type: "warning", title: DIALOG_TITLE, message, detail, buttons, defaultId: action ? 0 : close, cancelId: close, noLink: true });
    if (choice.response === details) {
      await showOutput(output);
      continue;
    }
    if (action && choice.response === 0) await runs[action]?.();
    return;
  }
}

/** The output itself, for a bug report: its end on screen, all of it on the clipboard. */
async function showOutput(output: string): Promise<void> {
  let copied = false;
  for (;;) {
    const choice = await dialog.showMessageBox({
      type: "none",
      title: DIALOG_TITLE,
      message: copied ? L.failureOutputCopied : L.failureOutput,
      detail: output.slice(-4000),
      buttons: [L.copyOutput, L.close],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response !== 0) return;
    clipboard.writeText(output);
    copied = true;
  }
}

async function restartAfterFailure(): Promise<void> {
  const out = await runCli(["restart"]);
  void poll();
  if (failedOutput(out)) await showFailure(L.updatedFailed, out);
  else await dialog.showMessageBox({ type: "info", title: DIALOG_TITLE, message: L.routerRestarted });
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

/** "5h 14% · weekly 10%", the same reading the dashboard gives. */
function windowsText(quota: Quota | undefined): string {
  const limits = quota?.rate_limits;
  return [limits?.primary, limits?.secondary]
    .filter((w): w is QuotaWindow => !!w && typeof w.used_percent === "number")
    .map((w) => {
      const minutes = w.window_minutes;
      const period = minutes === 300 ? L.window5h : minutes === 10080 ? L.windowWeek
        : typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
          ? new Intl.NumberFormat(uiLang(), { style: "unit", unit: "minute", unitDisplay: "short" }).format(minutes)
          : "?";
      return `${period} ${Math.round(w.used_percent!)}%`;
    })
    .join(" · ");
}

function render(): void {
  pushState();
  if (!tray) return;
  const state = healthy(last);
  // The direct mode is chosen, not broken: its own mark, and no "cannot connect" line.
  const shown = trayState(state, rec.doctor);
  const direct = shown === "direct";
  tray.setImage(icon(shown));
  const s = last;
  const quota = Object.values(s?.chatgpt?.quota ?? {}).find((q) => q);
  const quotaWindows = windowsText(quota ?? undefined);
  const quotaLine = quotaWindows ? `${["ChatGPT", quota?.plan_type].filter(Boolean).join(" ")} · ${quotaWindows}` : null;
  // Two status lines (clickable: they open the window), then only the actions that need the tray.
  // Everything else lives in the GUI window. Disabled items render grey, so the status lines stay enabled.
  const connected = !!s && s.settings.HTTPS_PROXY === `http://127.0.0.1:${s.listen.port}`;
  // "Router not running" is useless advice to someone who has never set it up — that reads as a
  // fault when the truth is there is one step left. Separate the two states everywhere.
  const unconfigured = !s && needsSetup();
  const headline = direct
    ? `ClaudeRipple · ${L.directHeadline}`
    : s
      ? `ClaudeRipple · ${state === "ok" ? L.healthy : L.attentionNeeded}`
      : `ClaudeRipple · ${unconfigured ? L.setupNeeded : L.routerNotRunning}`;
  // What is actually in the way, not only that something is: the router's readiness list names it.
  const problems = (s?.readiness?.problems ?? []).map((code) => L.problem(code));
  const detail = direct
    ? null
    : s
      ? [connected ? L.connected : L.notConnected, ...problems, quotaLine].filter(Boolean).join(" · ")
      : unconfigured
        ? L.setupNeededDetail
        : L.downNotifyTitle;
  // One line per Claude subscription account, current login first (#40).
  const claudeLines = (s?.claude?.accounts ?? [])
    .map((account) => ({ account, windows: windowsText(account.quota) }))
    .filter(({ windows }) => windows)
    .map(({ account, windows }) => ({ label: L.claudeUsage(account.id === "current" ? L.claudeCurrent : account.label, windows), click: () => void openDashboard() }) as Electron.MenuItemConstructorOptions);
  // The laptop settings people change on the way out, without opening the window. A mode picked
  // here has no end time, so it clears one set in the dashboard.
  const laptop = power;
  const modeLabel = (m: AwakeMode): string => (m === "off" ? L.awakeOff : m === "working" ? L.awakeWorking : L.awakeOn);
  const laptopItems: Electron.MenuItemConstructorOptions[] = laptop
    ? [
        {
          label: L.awakeMenu(modeLabel(laptop.awake.mode)),
          submenu: [
            ...(["off", "working", "on"] as const).map(
              (m) => ({ label: modeLabel(m), type: "radio", checked: laptop.awake.mode === m, click: () => void changePower({ awake: { mode: m, until: null } }) }) as Electron.MenuItemConstructorOptions,
            ),
            { type: "separator" },
            { label: L.tetherItem, type: "checkbox", checked: laptop.tether.enabled, click: (item) => void changePower({ tether: { enabled: item.checked } }) },
            { type: "separator" },
            { label: laptop.awake.setup === "needs-setup" ? L.laptopSetup : L.laptopOpen, click: () => showWindow("mac") },
          ],
        },
        { type: "separator" },
      ]
    : [];
  const template: Electron.MenuItemConstructorOptions[] = [
    // First, because it is the way back when nothing else works: the window needs no router.
    { label: L.open, click: () => void openDashboard() },
    { type: "separator" },
    { label: headline, click: () => void openDashboard() },
    ...(detail ? [{ label: detail, click: () => void openDashboard() } as Electron.MenuItemConstructorOptions] : []),
    ...claudeLines,
    ...(s?.autoUpdate?.hostUpdate?.status === "pending" ? [{ label: "호스트 적용 대기", click: () => void openDashboard() }] : []),
    ...(availableUpdate
      ? [{ label: updating ? L.updating(availableUpdate.latest ?? "") : L.updateAvailableItem(availableUpdate.latest ?? ""), enabled: !updating, click: () => void offerUpdate(availableUpdate!) } as Electron.MenuItemConstructorOptions]
      : []),
    { type: "separator" },
    ...laptopItems,
    { label: L.startAtLogin, type: "checkbox", checked: loginItemOn(), click: (item) => { void setLoginItem(item.checked); } },
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
    { label: L.checkUpdates, enabled: !updating, click: () => void checkUpdatesInteractive() },
    { label: L.about, click: () => void dialog.showMessageBox({ title: "ClaudeRipple", message: `ClaudeRipple ${trayVersion()}`, detail: L.aboutDetail }) },
    { label: L.quit, role: "quit" },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(direct ? L.tooltipDirect : s ? L.tooltip(state) : L.tooltipDown);
}

/**
 * The dashboard this app draws: the copy of packages/ui inside a packaged build, else the one next
 * to the tray's own folder (a checkout's packages/ui, an npm install's dist/ui — the same files the
 * router serves).
 */
function uiRoot(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources ? [path.join(resources, "clauderipple", "packages", "ui")] : []),
    path.resolve(__dirname, "..", "..", "ui"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) ?? candidates[candidates.length - 1]!;
}

registerScheme();

// One tray. `clauderipple tray` run while one is up started a second icon (Windows VM,
// 2026-10-10); the newcomer now leaves at once with code 0, which the CLI reads as "already running".
if (process.env.CLAUDERIPPLE_APP_USER_DATA) app.setPath("userData", process.env.CLAUDERIPPLE_APP_USER_DATA);
if (!app.requestSingleInstanceLock()) app.exit(0);

// Opening the app again (Finder, Start menu, `clauderipple tray`) while it already runs in the
// tray is someone looking for it: bring the window forward rather than nothing.
app.on("second-instance", () => {
  if (app.isReady()) showWindow(last ? undefined : "health");
});
// macOS does not start a second instance for that: clicking the icon of a running app only sends
// it a reopen, which Electron reports as `activate`. Without this the icon did nothing and the
// window opened only from the tray menu (2026-10-30).
app.on("activate", () => {
  if (app.isReady()) showWindow(last ? undefined : "health");
});

app.whenReady().then(async () => {
  L = STRINGS[uiLang()];
  handleScheme(uiRoot(), adminUrl);
  wireBridge();
  // Without this, Windows attributes our notifications to "Electron" instead of ClaudeRipple.
  if (process.platform === "win32") app.setAppUserModelId("com.clauderipple.app");
  // macOS keeps its application menu (it owns Cmd-Q and the edit shortcuts); elsewhere it is noise.
  if (!isMac) Menu.setApplicationMenu(null);
  if (isMac) app.dock?.hide();
  tray = new Tray(icon("down"));
  tray.on("click", () => tray?.popUpContextMenu());
  render();
  // First-run default and migration from bare Electron both use the npm tray's LaunchAgent. It runs
  // the CLI, so the icon is drawn first and the menu's checkbox follows when it answers.
  void initializeLoginItem().then(render, (error: unknown) => console.error(`ClaudeRipple login item initialization failed: ${error}`));
  // Opened from its icon (the CLI sets this; a login launch does not): show the window, not just a
  // tray icon the person may never notice. Taken out so an update's relaunch does not inherit it.
  if (process.env.CLAUDERIPPLE_APP_SHOW === "1") {
    delete process.env.CLAUDERIPPLE_APP_SHOW;
    showWindow("health");
  }
  void poll();
  setInterval(() => void poll(), POLL_MS);
  // What the health poll cannot see (the direct mode, a supervisor gone missing) comes from doctor.
  setTimeout(() => void refreshDoctor(), 3_000);
  setInterval(() => void (!rec.busy && refreshDoctor()), DOCTOR_EVERY_MS);
  setInterval(() => void (windowVisible() && !rec.busy && refreshDoctor()), DOCTOR_WHILE_OPEN_MS);
  if (needsSetup()) void promptForSetup();
  // Not at the very start: a tray opened at login shares the first minute with everything else.
  setTimeout(() => void checkForUpdate(), 60_000);
  setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS);
});

// A tray-only app owns no windows; without this Electron would quit the moment a dialog closes.
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
