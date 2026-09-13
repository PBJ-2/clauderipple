// ClaudeRipple menu-bar app. It owns no logic: the router serves the GUI and the admin API on
// 127.0.0.1; this shell adds a tray icon with live health, a window for the GUI, and shortcuts
// for restart / logs / login. If the router is down the tray says so and offers to start it.

import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, clipboard } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Status = {
  version: string;
  listen: { host: string; port: number };
  adminPort: number;
  stats: { started: number; completed: number; failed: number; inFlight: number };
  consecutiveUpstreamFailures: number;
  routes: number;
  providers: Record<string, { url?: string; reachable: boolean; type?: string }>;
  settings: { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string };
  cliVersion: string;
  chatgpt?: { quota: Record<string, Record<string, unknown> | null>; auth: Record<string, string> };
  picker?: { enabled: boolean; hosts: string[]; last: unknown };
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
    connected: "Claude Desktop → ClaudeRipple ✓",
    notConnected: "Claude Desktop is NOT using ClaudeRipple",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan}: ${percent}% of week used`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    openWindow: "Open ClaudeRipple…",
    openInBrowser: "Open in Browser",
    restartRouter: "Restart Router",
    startRouter: "Start Router",
    pickerOn: "Show GPT models in the Code tab picker…",
    pickerOff: "Stop showing GPT models in the picker…",
    pickerState: (on: boolean): string => (on ? "Picker: GPT models shown by name ✓" : "Picker: GPT models via Claude names (alias mode)"),
    pickerOnConfirm: "macOS will ask for your login password to trust the ClaudeRipple certificate (ClaudeRipple never sees it). Then quit and reopen Claude Desktop.",
    pickerDone: "Done. Now quit Claude Desktop completely and open it again, then check the Code tab picker.",
    pickerOffDone: "Done. Quit and reopen Claude Desktop to apply.",
    cancel: "Cancel",
    signInChatgpt: "Sign in to ChatGPT…",
    copyStatus: "Copy Status",
    showLogs: "Show Logs",
    about: "About ClaudeRipple",
    aboutDetail:
      "Run GPT and other models inside Claude Desktop, without turning Claude off.\n\nIndependent open-source project (MIT). Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC.",
    quit: "Quit",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: router not running",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `Proxy ${host}:${port} · ${slots} · ${flight}`,
  },
  ko: {
    healthy: "정상",
    attentionNeeded: "확인 필요",
    routerNotRunning: "라우터가 꺼져 있음",
    slotsMapped: (n: number) => `슬롯 ${n}개 매핑`,
    inFlight: "진행 중",
    connected: "Claude Desktop → ClaudeRipple 연결됨 ✓",
    notConnected: "Claude Desktop이 ClaudeRipple을 쓰고 있지 않음",
    percentOfWeekUsed: (percent: string | number, plan: string) => `ChatGPT ${plan}: 주간 한도 ${percent}% 사용`,
    cliVersion: (v: string) => `Claude Code CLI ${v}`,
    openWindow: "ClaudeRipple 열기…",
    openInBrowser: "브라우저에서 열기",
    restartRouter: "라우터 재시작",
    startRouter: "라우터 시작",
    pickerOn: "Code 탭 피커에 GPT 모델 이름 표시…",
    pickerOff: "피커의 GPT 모델 표시 끄기…",
    pickerState: (on: boolean): string => (on ? "피커: GPT 모델을 실명으로 표시 중 ✓" : "피커: Claude 이름으로 GPT 사용(별칭 모드)"),
    pickerOnConfirm: "ClaudeRipple 인증서를 신뢰하기 위해 macOS가 로그인 암호를 묻습니다(ClaudeRipple은 암호를 보지 않습니다). 끝나면 Claude Desktop을 완전히 종료했다가 다시 여세요.",
    pickerDone: "완료. 이제 Claude Desktop을 완전히 종료한 뒤 다시 열고 Code 탭 피커를 확인하세요.",
    pickerOffDone: "완료. Claude Desktop을 종료했다가 다시 열면 적용됩니다.",
    cancel: "취소",
    signInChatgpt: "ChatGPT 로그인…",
    copyStatus: "상태 복사",
    showLogs: "로그 보기",
    about: "ClaudeRipple 정보",
    aboutDetail:
      "Claude Desktop을 끄지 않고 그 안에서 GPT 등 다른 모델을 씁니다.\n\n독립 오픈소스 프로젝트(MIT)이며 Anthropic·OpenAI와 제휴·보증·후원 관계가 없습니다. Claude와 Claude Code는 Anthropic, PBC의 상표입니다.",
    quit: "종료",
    tooltip: (state: string) => `ClaudeRipple ${state}`,
    tooltipDown: "ClaudeRipple: 라우터가 꺼져 있음",
    proxyLine: (host: string, port: number, slots: string, flight: string) => `프록시 ${host}:${port} · ${slots} · ${flight}`,
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
let win: BrowserWindow | null = null;
let last: Status | null = null;
let lastError: string | null = null;

function adminUrl(): string {
  return `http://127.0.0.1:${readConfigPorts().admin}/`;
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${adminUrl()}api/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    last = (await res.json()) as Status;
    lastError = null;
  } catch (e) {
    last = null;
    lastError = (e as Error).message;
  }
  render();
}

function healthy(s: Status | null): "ok" | "warn" | "down" {
  if (!s) return "down";
  const proxyOk = s.settings.HTTPS_PROXY === `http://127.0.0.1:${s.listen.port}`;
  const providersOk = Object.values(s.providers).every((p) => p.reachable !== false);
  if (!proxyOk || s.consecutiveUpstreamFailures > 0) return "warn";
  return providersOk ? "ok" : "warn";
}

function icon(state: "ok" | "warn" | "down"): Electron.NativeImage {
  const file = path.join(__dirname, "..", "assets", state === "ok" ? "trayTemplate.png" : state === "warn" ? "trayWarnTemplate.png" : "trayDownTemplate.png");
  const img = nativeImage.createFromPath(file);
  img.setTemplateImage(true);
  return img;
}

function openWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    title: "ClaudeRipple",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void win.loadURL(adminUrl());
  // Menu-bar app: no Dock icon while only the tray exists; show one while the settings window is open
  // (so Cmd-Tab and the Dock can reach it), hide it again when the window closes.
  if (process.platform === "darwin") void app.dock?.show();
  win.on("closed", () => {
    win = null;
    if (process.platform === "darwin") app.dock?.hide();
  });
}

/** Node 24 + CLI source paths recorded by `clauderipple install` (the packaged app carries neither,
 *  and Electron's own Node cannot run .ts sources). */
function cliPaths(): { node: string; cli: string } {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(home, "paths.json"), "utf8")) as { node?: string; cli?: string };
    if (p.node && p.cli && fs.existsSync(p.node) && fs.existsSync(p.cli)) return { node: p.node, cli: p.cli };
  } catch {
    /* fall through to the dev layout */
  }
  return { node: process.execPath, cli: path.resolve(__dirname, "..", "..", "cli", "src", "index.ts") };
}

function runCli(args: string[]): Promise<string> {
  const { node, cli } = cliPaths();
  return new Promise((resolve) => {
    execFile(node, [cli, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLAUDERIPPLE_HOME: home } }, (err, stdout, stderr) => {
      resolve(`${stdout}${stderr}${err ? `\n${err.message}` : ""}`.trim());
    });
  });
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
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: s ? `ClaudeRipple ${s.version} — ${state === "ok" ? L.healthy : L.attentionNeeded}` : `ClaudeRipple — ${L.routerNotRunning}${lastError ? ` (${lastError})` : ""}`, enabled: false },
    ...(s
      ? [
          { label: L.proxyLine(`127.0.0.1`, s.listen.port, L.slotsMapped(s.routes), `${s.stats.inFlight} ${L.inFlight}`), enabled: false } as Electron.MenuItemConstructorOptions,
          { label: s.settings.HTTPS_PROXY === `http://127.0.0.1:${s.listen.port}` ? L.connected : L.notConnected, enabled: false } as Electron.MenuItemConstructorOptions,
          ...Object.entries(s.providers).map(([name, p]) => ({ label: `${p.reachable === false ? "✗" : "✓"} provider ${name}${p.type ? ` (${p.type})` : ""}`, enabled: false }) as Electron.MenuItemConstructorOptions),
          ...(quotaLine ? [{ label: quotaLine, enabled: false } as Electron.MenuItemConstructorOptions] : []),
          { label: L.cliVersion(s.cliVersion), enabled: false } as Electron.MenuItemConstructorOptions,
          { label: L.pickerState(!!s.picker?.enabled), enabled: false } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    { type: "separator" },
    { label: L.openWindow, click: openWindow, enabled: !!s },
    { label: L.openInBrowser, click: () => void shell.openExternal(adminUrl()), enabled: !!s },
    { type: "separator" },
    {
      label: s?.picker?.enabled ? L.pickerOff : L.pickerOn,
      enabled: !!s,
      click: async () => {
        const on = !s?.picker?.enabled;
        if (on) {
          const r = await dialog.showMessageBox({ message: L.pickerOn, detail: L.pickerOnConfirm, buttons: ["OK", L.cancel], cancelId: 1 });
          if (r.response !== 0) return;
        }
        const out = await runCli(["picker", on ? "on" : "off"]);
        const failed = /error|not enabled|not trusted/i.test(out) && !/✓ picker.enabled/.test(out);
        await dialog.showMessageBox({ message: failed ? out : on ? L.pickerDone : L.pickerOffDone, detail: failed ? undefined : out });
        void poll();
      },
    },
    { type: "separator" },
    { label: s ? L.restartRouter : L.startRouter, click: async () => void dialog.showMessageBox({ message: await runCli([s ? "restart" : "start"]) }) },
    { label: L.signInChatgpt, click: async () => void dialog.showMessageBox({ message: await runCli(["login"]) }) },
    { label: L.copyStatus, click: async () => clipboard.writeText(await runCli(["status"])) },
    { label: L.showLogs, click: () => void shell.openPath(path.join(home, "logs", "router.log")) },
    { type: "separator" },
    { label: L.about, click: () => void dialog.showMessageBox({ title: "ClaudeRipple", message: "ClaudeRipple", detail: L.aboutDetail }) },
    { label: L.quit, role: "quit" },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(s ? L.tooltip(state) : L.tooltipDown);
}

app.whenReady().then(() => {
  L = STRINGS[app.getLocale().startsWith("ko") ? "ko" : "en"];
  if (process.platform === "darwin") app.dock?.hide();
  tray = new Tray(icon("down"));
  tray.on("click", () => tray?.popUpContextMenu());
  render();
  void poll();
  setInterval(() => void poll(), POLL_MS);
  if (process.env.CLAUDERIPPLE_OPEN_WINDOW) openWindow(); // dev/testing: show the GUI window immediately
});

app.on("window-all-closed", () => {
  /* keep running in the tray */
});
