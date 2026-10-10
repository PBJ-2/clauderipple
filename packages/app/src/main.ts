// ClaudeRipple menu-bar app. It owns no logic: the router serves the GUI and the admin API on
// 127.0.0.1; this shell adds a tray icon with live health, a window for the GUI, and shortcuts
// for restart / logs / login. If the router is down the tray says so and offers to start it.

import { app, Menu, Tray, Notification, nativeImage, shell, dialog, clipboard } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type QuotaWindow = { used_percent?: number; window_minutes?: number };
type Quota = { rate_limits?: { primary?: QuotaWindow | null; secondary?: QuotaWindow | null } };

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
  /** Reported from 0.6.0 on, where a Claude subscription provider is configured. */
  claude?: { accounts: { id: string; label: string; quota: Quota }[] };
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
    claudeCurrent: "current login",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5h",
    windowWeek: "weekly",
    checkUpdates: "Check for Updates…",
    updateAvailableItem: (v: string) => `Update to ClaudeRipple ${v}…`,
    upToDate: (v: string) => `ClaudeRipple ${v} is the latest version.`,
    updateAvailable: (latest: string, current: string) => `ClaudeRipple ${latest} is available (you have ${current}).`,
    updateDetail: "The router restarts on the new version once requests in flight have finished. The tray reopens by itself.",
    updateNow: "Update",
    later: "Later",
    updating: (v: string) => `Updating to ClaudeRipple ${v}…`,
    updateDone: (v: string) => `Updated to ClaudeRipple ${v}`,
    updateFailed: "The update did not finish",
    updateCheckFailed: "Could not check for updates",
    updatePackaged: "This is the standalone app. Download the new version from the releases page.",
    updateCheckout: "This is a source checkout. Update it with git pull.",
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
    claudeCurrent: "현재 로그인",
    claudeUsage: (label: string, windows: string) => `Claude ${label} · ${windows}`,
    window5h: "5시간",
    windowWeek: "주간",
    checkUpdates: "업데이트 확인…",
    updateAvailableItem: (v: string) => `새 버전 업데이트: ClaudeRipple ${v}…`,
    upToDate: (v: string) => `최신 버전입니다: ClaudeRipple ${v}`,
    updateAvailable: (latest: string, current: string) => `새 버전이 나왔습니다: ClaudeRipple ${latest} (지금 ${current})`,
    updateDetail: "진행 중인 요청이 끝나면 라우터가 새 버전으로 다시 시작합니다. 트레이는 저절로 다시 열립니다.",
    updateNow: "업데이트",
    later: "나중에",
    updating: (v: string) => `ClaudeRipple ${v} 업데이트 중…`,
    updateDone: (v: string) => `ClaudeRipple ${v} 업데이트 완료`,
    updateFailed: "업데이트를 마치지 못했습니다",
    updateCheckFailed: "업데이트를 확인하지 못했습니다",
    updatePackaged: "독립 실행 앱입니다. 릴리스 페이지에서 새 버전을 받으세요.",
    updateCheckout: "소스 체크아웃입니다. git pull로 업데이트하세요.",
  },
  zh: {
    healthy: "运行正常",
    attentionNeeded: "需要处理",
    routerNotRunning: "路由服务未运行",
    slotsMapped: (n: number) => `已映射 ${n} 个槽位`,
    inFlight: "进行中",
    connected: "Claude Desktop 已连接",
    notConnected: "Claude Desktop 未连接",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan} 本周已用 ${percent}%`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "重启路由服务",
    startRouter: "启动路由服务",
    pickerOn: "在 Code 标签页的模型选择器中显示 GPT 模型…",
    pickerOff: "不再在模型选择器中显示 GPT 模型…",
    pickerState: (on: boolean): string => (on ? "模型选择器：以真实名称显示 GPT 模型 ✓" : "模型选择器：通过 Claude 模型名使用 GPT 模型（别名模式）"),
    pickerOnConfirm: "macOS 会要求输入登录密码以信任 ClaudeRipple 证书（ClaudeRipple 永远不会看到密码）。之后请退出并重新打开 Claude Desktop。",
    pickerDone: "完成。现在请完全退出 Claude Desktop 再重新打开，然后查看 Code 标签页的模型选择器。",
    pickerOffDone: "完成。退出并重新打开 Claude Desktop 后生效。",
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
    setupFailed: "设置未完成",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `正在运行的路由服务版本为 ${from}，正在切换到当前版本…`,
    updatedFailed: "无法将路由服务切换到当前版本",
    problem: (code: string) =>
      code === "settings" ? "Claude Code 未指向 ClaudeRipple"
      : code === "upstream" ? "无法连接 Anthropic"
      : code === "picker-ca" ? "选择器模式：证书未被信任"
      : code === "picker-proxy" ? "选择器模式：未设置 Claude Desktop 代理"
      : code.startsWith("provider:") ? `无法连接供应商 ${code.slice(9)}`
      : code,
    about: "关于 ClaudeRipple",
    aboutDetail:
      "在 Claude Desktop 中运行 GPT 和其他模型，无需关闭 Claude。\n\n独立开源项目（GPL-3.0）。与 Anthropic 和 OpenAI 均无关联，未获其认可或赞助。Claude 和 Claude Code 是 Anthropic, PBC 的商标。",
    quit: "退出",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple：路由服务未运行 — Claude Desktop 无法连接",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `代理 ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "登录时启动",
    downNotifyTitle: "Claude Desktop 无法连接",
    downNotifyBody: "ClaudeRipple 路由服务未运行，因此 Claude Desktop 无法向外发送请求。点击即可启动路由服务。",
    starting: "正在启动路由服务…",
    openDashboard: "在浏览器中打开控制面板…",
    offlineHeading: "路由服务未运行",
    offlineBody:
      "Claude Desktop 的所有流量都经过 ClaudeRipple，因此路由服务停止期间，应用会显示空白窗口并报 ERR_PROXY_CONNECTION_FAILED。请启动路由服务，然后重新加载 Claude Desktop。",
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
    updateDetail: "进行中的请求处理完毕后，路由服务会以新版本重启。托盘应用会自动重新打开。",
    updateNow: "更新",
    later: "稍后",
    updating: (v: string) => `正在更新到 ClaudeRipple ${v}…`,
    updateDone: (v: string) => `已更新到 ClaudeRipple ${v}`,
    updateFailed: "更新未完成",
    updateCheckFailed: "无法检查更新",
    updatePackaged: "这是独立打包的应用。请从发布页面下载新版本。",
    updateCheckout: "这是从仓库检出的源码版本，请用 git pull 更新。",
  },
  ja: {
    healthy: "正常",
    attentionNeeded: "要確認",
    routerNotRunning: "ルーター停止中",
    slotsMapped: (n: number) => `${n}個のスロットをマッピング済み`,
    inFlight: "処理中",
    connected: "Claude Desktop 接続済み",
    notConnected: "Claude Desktop 未接続",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan} 今週 ${percent}% 使用`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "ルーターを再起動",
    startRouter: "ルーターを起動",
    pickerOn: "CodeタブのピッカーにGPTモデルを表示…",
    pickerOff: "ピッカーのGPTモデルを非表示にする…",
    pickerState: (on: boolean): string => (on ? "ピッカー：GPTモデルを実際の名前で表示 ✓" : "ピッカー：Claudeの名前経由でGPTモデルを使用（エイリアスモード）"),
    pickerOnConfirm: "ClaudeRippleの証明書を信頼するため、macOSがログインパスワードを求めます（ClaudeRippleがパスワードを見ることはありません）。その後、Claude Desktopを終了して開き直してください。",
    pickerDone: "完了しました。Claude Desktopを完全に終了してから開き直し、Codeタブのピッカーを確認してください。",
    pickerOffDone: "完了しました。反映するには、Claude Desktopを終了して開き直してください。",
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
    setupFailed: "セットアップが完了しませんでした",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `実行中のルーターは ${from} です。このバージョンに切り替えています…`,
    updatedFailed: "ルーターをこのバージョンに切り替えられませんでした",
    problem: (code: string) =>
      code === "settings" ? "Claude Codeの接続先がClaudeRippleになっていません"
      : code === "upstream" ? "Anthropicに接続できません"
      : code === "picker-ca" ? "ピッカーモード：証明書が信頼されていません"
      : code === "picker-proxy" ? "ピッカーモード：Claude Desktopのプロキシが未設定です"
      : code.startsWith("provider:") ? `プロバイダー ${code.slice(9)} に接続できません`
      : code,
    about: "ClaudeRippleについて",
    aboutDetail:
      "Claudeをオフにすることなく、Claude Desktopの中でGPTなどのモデルを動かします。\n\n独立したオープンソースプロジェクトです（GPL-3.0）。AnthropicおよびOpenAIとは提携関係になく、両社による承認や後援も受けていません。ClaudeおよびClaude Codeは、Anthropic, PBCの商標です。",
    quit: "終了",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple：ルーター停止中 — Claude Desktopは接続できません",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `プロキシ ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "ログイン時に起動",
    downNotifyTitle: "Claude Desktopが接続できません",
    downNotifyBody: "ClaudeRippleのルーターが停止しているため、Claude Desktopは外部と通信できません。クリックして起動してください。",
    starting: "ルーターを起動中…",
    openDashboard: "ブラウザでダッシュボードを開く…",
    offlineHeading: "ルーターが停止しています",
    offlineBody:
      "Claude Desktopはすべての通信をClaudeRipple経由で送るため、ルーターが停止している間はERR_PROXY_CONNECTION_FAILEDと表示された空白のウィンドウになります。ルーターを起動してから、Claude Desktopを再読み込みしてください。",
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
    updateDone: (v: string) => `ClaudeRipple ${v} にアップデートしました`,
    updateFailed: "アップデートが完了しませんでした",
    updateCheckFailed: "アップデートを確認できませんでした",
    updatePackaged: "これはスタンドアロン版のアプリです。リリースページから新しいバージョンをダウンロードしてください。",
    updateCheckout: "これはソースから実行している環境です。git pullで更新してください。",
  },
  es: {
    healthy: "en buen estado",
    attentionNeeded: "requiere atención",
    routerNotRunning: "router detenido",
    slotsMapped: (n: number) => `${n} ${n === 1 ? "slot asignado" : "slots asignados"}`,
    inFlight: "en curso",
    connected: "Claude Desktop conectado",
    notConnected: "Claude Desktop no conectado",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan} ${percent}% esta semana`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "Reiniciar router",
    startRouter: "Iniciar router",
    pickerOn: "Mostrar modelos GPT en el selector de la pestaña Code…",
    pickerOff: "Dejar de mostrar modelos GPT en el selector…",
    pickerState: (on: boolean): string => (on ? "Selector: modelos GPT con su nombre ✓" : "Selector: modelos GPT bajo nombres de Claude (modo alias)"),
    pickerOnConfirm: "macOS te pedirá tu contraseña de inicio de sesión para confiar en el certificado de ClaudeRipple (ClaudeRipple nunca la ve). Después, cierra Claude Desktop por completo y vuelve a abrirlo.",
    pickerDone: "Listo. Ahora cierra Claude Desktop por completo, vuelve a abrirlo y revisa el selector de la pestaña Code.",
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
    setupFailed: "La configuración no se completó",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `El router en ejecución está en la versión ${from}. Cambiándolo a esta versión…`,
    updatedFailed: "No se pudo cambiar el router a esta versión",
    problem: (code: string) =>
      code === "settings" ? "Claude Code no apunta a ClaudeRipple"
      : code === "upstream" ? "No se puede acceder a Anthropic"
      : code === "picker-ca" ? "modo selector: el certificado no es de confianza"
      : code === "picker-proxy" ? "modo selector: proxy de Claude Desktop sin configurar"
      : code.startsWith("provider:") ? `no se puede acceder al proveedor ${code.slice(9)}`
      : code,
    about: "Acerca de ClaudeRipple",
    aboutDetail:
      "Usa GPT y otros modelos dentro de Claude Desktop sin desactivar Claude.\n\nProyecto independiente de código abierto (GPL-3.0). No está afiliado a Anthropic ni a OpenAI, ni cuenta con su respaldo ni con su patrocinio. Claude y Claude Code son marcas comerciales de Anthropic, PBC.",
    quit: "Salir",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: router detenido — Claude Desktop no puede conectarse",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "Abrir al iniciar sesión",
    downNotifyTitle: "Claude Desktop no puede conectarse",
    downNotifyBody: "El router de ClaudeRipple no está en ejecución, así que Claude Desktop no puede conectarse. Haz clic para iniciarlo.",
    starting: "iniciando el router…",
    openDashboard: "Abrir el panel en el navegador…",
    offlineHeading: "El router no está en ejecución",
    offlineBody:
      "Claude Desktop envía todo su tráfico a través de ClaudeRipple, así que mientras el router esté detenido la app muestra una ventana en blanco con ERR_PROXY_CONNECTION_FAILED. Inicia el router y recarga Claude Desktop.",
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
    updateDetail: "El router se reinicia con la nueva versión cuando terminan las solicitudes en curso. La app de la bandeja se vuelve a abrir sola.",
    updateNow: "Actualizar",
    later: "Más tarde",
    updating: (v: string) => `Actualizando a ClaudeRipple ${v}…`,
    updateDone: (v: string) => `Actualizado a ClaudeRipple ${v}`,
    updateFailed: "La actualización no se completó",
    updateCheckFailed: "No se pudo comprobar si hay actualizaciones",
    updatePackaged: "Esta es la app independiente. Descarga la nueva versión desde la página de versiones.",
    updateCheckout: "Esta es una copia del código fuente. Actualízala con git pull.",
  },
  pt: {
    healthy: "funcionando",
    attentionNeeded: "requer atenção",
    routerNotRunning: "roteador parado",
    slotsMapped: (n: number) => `${n} slot${n === 1 ? "" : "s"} mapeado${n === 1 ? "" : "s"}`,
    inFlight: "em andamento",
    connected: "Claude Desktop conectado",
    notConnected: "Claude Desktop não conectado",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan} ${percent}% nesta semana`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    restartRouter: "Reiniciar roteador",
    startRouter: "Iniciar roteador",
    pickerOn: "Mostrar modelos GPT no seletor da aba Code…",
    pickerOff: "Parar de mostrar modelos GPT no seletor…",
    pickerState: (on: boolean): string => (on ? "Seletor: modelos GPT exibidos pelo nome ✓" : "Seletor: modelos GPT via nomes do Claude (modo alias)"),
    pickerOnConfirm: "O macOS vai pedir sua senha de login para confiar no certificado do ClaudeRipple (o ClaudeRipple nunca a vê). Depois, encerre o Claude Desktop e abra-o de novo.",
    pickerDone: "Pronto. Agora encerre o Claude Desktop por completo, abra-o de novo e confira o seletor da aba Code.",
    pickerOffDone: "Pronto. Encerre o Claude Desktop e abra-o de novo para aplicar.",
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
    setupFailed: "A configuração não foi concluída",
    updatedTitle: (v: string) => `ClaudeRipple ${v}`,
    updatedRestarting: (from: string) => `O roteador em execução está na versão ${from}. Mudando para esta versão…`,
    updatedFailed: "Não foi possível mudar o roteador para esta versão",
    problem: (code: string) =>
      code === "settings" ? "O Claude Code não está configurado para usar o ClaudeRipple"
      : code === "upstream" ? "A Anthropic está inacessível"
      : code === "picker-ca" ? "modo seletor: certificado não confiável"
      : code === "picker-proxy" ? "modo seletor: proxy do Claude Desktop não configurado"
      : code.startsWith("provider:") ? `provedor ${code.slice(9)} inacessível`
      : code,
    about: "Sobre o ClaudeRipple",
    aboutDetail:
      "Rode o GPT e outros modelos dentro do Claude Desktop, sem desligar o Claude.\n\nProjeto open source independente (GPL-3.0). Não tem afiliação com a Anthropic nem com a OpenAI, nem é endossado ou patrocinado por nenhuma delas. Claude e Claude Code são marcas comerciais da Anthropic, PBC.",
    quit: "Sair",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: roteador parado — o Claude Desktop não consegue se conectar",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
    startAtLogin: "Iniciar ao fazer login",
    downNotifyTitle: "O Claude Desktop não consegue se conectar",
    downNotifyBody: "O roteador do ClaudeRipple não está rodando, então o Claude Desktop não consegue acessar a rede. Clique para iniciá-lo.",
    starting: "iniciando o roteador…",
    openDashboard: "Abrir painel no navegador…",
    offlineHeading: "O roteador não está rodando",
    offlineBody:
      "O Claude Desktop envia todo o tráfego pelo ClaudeRipple, então, enquanto o roteador estiver parado, o app mostra uma janela em branco com ERR_PROXY_CONNECTION_FAILED. Inicie o roteador e recarregue o Claude Desktop.",
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
    updateDetail: "O roteador reinicia na nova versão assim que as requisições em andamento terminarem. O app da bandeja reabre sozinho.",
    updateNow: "Atualizar",
    later: "Depois",
    updating: (v: string) => `Atualizando para o ClaudeRipple ${v}…`,
    updateDone: (v: string) => `Atualizado para o ClaudeRipple ${v}`,
    updateFailed: "A atualização não foi concluída",
    updateCheckFailed: "Não foi possível verificar atualizações",
    updatePackaged: "Este é o app independente. Baixe a nova versão na página de releases.",
    updateCheckout: "Isto é um checkout do código-fonte. Atualize com git pull.",
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

/**
 * How Windows starts this tray at login. A packaged app is its own binary. Installed from npm, the
 * binary is a bare Electron that needs our script after it: registered without one, every logon
 * opened Electron's default app and no tray (issue #50). macOS ignores `path`/`args`.
 */
function loginItemLaunch(): { path: string; args: string[] } | undefined {
  if (app.isPackaged || process.platform !== "win32" || !process.argv[1]) return undefined;
  return { path: process.execPath, args: [path.resolve(process.argv[1])] };
}

function loginItemOn(): boolean {
  try {
    return app.getLoginItemSettings(loginItemLaunch()).openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItem(on: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: on, ...loginItemLaunch() });
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
function uiLang(): keyof typeof STRINGS {
  const candidates = [...app.getPreferredSystemLanguages(), app.getSystemLocale(), app.getLocale()];
  const first = candidates.find((l) => typeof l === "string" && l.length > 0) ?? "en";
  // Every Chinese locale gets the Simplified text and every Portuguese one the Brazilian text.
  const base = first.toLowerCase().split(/[-_]/)[0]!;
  return base in STRINGS ? (base as keyof typeof STRINGS) : "en";
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
    // An update restarts the router on purpose; that is not the outage the notification is for.
    if (!downNotified && !updating && Date.now() - downSince >= DOWN_NOTIFY_AFTER_MS) {
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
  return runCliResult(args).then((r) => r.output);
}

function runCliResult(args: string[]): Promise<{ ok: boolean; output: string }> {
  const { node, env, cli } = cliPaths();
  return new Promise((resolve) => {
    // An update prints npm's and the installer's own lines; the default 1MB buffer is not for that.
    execFile(node, [cli, ...args], { env: { ...process.env, ...env, CLAUDERIPPLE_HOME: home }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}${err ? `\n${err.message}` : ""}`.trim() });
    });
  });
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
  if (choice.response !== 0 || updating) return;
  updating = true;
  render();
  const version = check.latest ?? "";
  if (Notification.isSupported()) new Notification({ title: "ClaudeRipple", body: L.updating(version) }).show();
  const r = await runCliResult(["update"]);
  updating = false;
  if (!r.ok) {
    render();
    await dialog.showMessageBox({ type: "warning", message: L.updateFailed, detail: r.output.slice(-4000) });
    return;
  }
  availableUpdate = null;
  if (Notification.isSupported()) new Notification({ title: "ClaudeRipple", body: L.updateDone(version) }).show();
  // A new tray from the new files, then this one goes.
  await runCliResult(["tray"]);
  app.quit();
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

/** "5h 14% · weekly 10%", the same reading the dashboard gives. */
function windowsText(quota: Quota | undefined): string {
  const limits = quota?.rate_limits;
  return [limits?.primary, limits?.secondary]
    .filter((w): w is QuotaWindow => !!w && typeof w.used_percent === "number")
    .map((w) => `${w.window_minutes === 300 ? L.window5h : L.windowWeek} ${Math.round(w.used_percent!)}%`)
    .join(" · ");
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
  // One line per Claude subscription account, current login first (#40).
  const claudeLines = (s?.claude?.accounts ?? [])
    .map((account) => ({ account, windows: windowsText(account.quota) }))
    .filter(({ windows }) => windows)
    .map(({ account, windows }) => ({ label: L.claudeUsage(account.id === "current" ? L.claudeCurrent : account.label, windows), click: () => void openDashboard() }) as Electron.MenuItemConstructorOptions);
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: headline, click: () => void openDashboard() },
    ...(detail ? [{ label: detail, click: () => void openDashboard() } as Electron.MenuItemConstructorOptions] : []),
    ...claudeLines,
    ...(availableUpdate
      ? [{ label: updating ? L.updating(availableUpdate.latest ?? "") : L.updateAvailableItem(availableUpdate.latest ?? ""), enabled: !updating, click: () => void offerUpdate(availableUpdate!) } as Electron.MenuItemConstructorOptions]
      : []),
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
    { label: L.checkUpdates, enabled: !updating, click: () => void checkUpdatesInteractive() },
    { label: L.about, click: () => void dialog.showMessageBox({ title: "ClaudeRipple", message: `ClaudeRipple ${app.getVersion()}`, detail: L.aboutDetail }) },
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
  // An entry an older version wrote names bare Electron (the query without args finds it); the
  // user had start-at-login on, so it is rewritten with the script rather than left broken.
  else if (loginItemLaunch() && app.getLoginItemSettings().openAtLogin && !loginItemOn()) setLoginItem(true);
  tray = new Tray(icon("down"));
  tray.on("click", () => tray?.popUpContextMenu());
  render();
  void poll();
  setInterval(() => void poll(), POLL_MS);
  if (needsSetup()) void promptForSetup();
  // Not at the very start: a tray opened at login shares the first minute with everything else.
  setTimeout(() => void checkForUpdate(), 60_000);
  setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS);
});

// A tray-only app owns no windows; without this Electron would quit the moment a dialog closes.
app.on("window-all-closed", () => {
  /* keep running in the tray */
});
