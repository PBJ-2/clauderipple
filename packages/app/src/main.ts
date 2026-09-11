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
};

const home = process.env.CLAUDERIPPLE_HOME ?? path.join(os.homedir(), ".clauderipple");
const POLL_MS = 5000;

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
    title: "ClaudeRipple",
    titleBarStyle: "hiddenInset",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void win.loadURL(adminUrl());
  win.on("closed", () => (win = null));
}

function runCli(args: string[]): Promise<string> {
  const cli = path.resolve(__dirname, "..", "..", "cli", "src", "index.ts");
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLAUDERIPPLE_HOME: home } }, (err, stdout, stderr) => {
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
    ? `ChatGPT ${quota.plan_type ?? ""}: ${quota.rate_limits.primary.used_percent ?? "?"}% of week used`
    : null;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: s ? `ClaudeRipple ${s.version} — ${state === "ok" ? "healthy" : "attention needed"}` : `ClaudeRipple — router not running${lastError ? ` (${lastError})` : ""}`, enabled: false },
    ...(s
      ? [
          { label: `Proxy 127.0.0.1:${s.listen.port} · ${s.routes} slot${s.routes === 1 ? "" : "s"} mapped · ${s.stats.inFlight} in flight`, enabled: false } as Electron.MenuItemConstructorOptions,
          { label: s.settings.HTTPS_PROXY === `http://127.0.0.1:${s.listen.port}` ? "Claude Desktop → ClaudeRipple ✓" : "Claude Desktop is NOT using ClaudeRipple", enabled: false } as Electron.MenuItemConstructorOptions,
          ...Object.entries(s.providers).map(([name, p]) => ({ label: `${p.reachable === false ? "✗" : "✓"} provider ${name}${p.type ? ` (${p.type})` : ""}`, enabled: false }) as Electron.MenuItemConstructorOptions),
          ...(quotaLine ? [{ label: quotaLine, enabled: false } as Electron.MenuItemConstructorOptions] : []),
          { label: `Claude Code CLI ${s.cliVersion}`, enabled: false } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    { type: "separator" },
    { label: "Open ClaudeRipple…", click: openWindow, enabled: !!s },
    { label: "Open in Browser", click: () => void shell.openExternal(adminUrl()), enabled: !!s },
    { type: "separator" },
    { label: s ? "Restart Router" : "Start Router", click: async () => void dialog.showMessageBox({ message: await runCli([s ? "restart" : "start"]) }) },
    { label: "Sign in to ChatGPT…", click: async () => void dialog.showMessageBox({ message: await runCli(["login"]) }) },
    { label: "Copy Status", click: async () => clipboard.writeText(await runCli(["status"])) },
    { label: "Show Logs", click: () => void shell.openPath(path.join(home, "logs", "router.log")) },
    { type: "separator" },
    { label: "About ClaudeRipple", click: () => void dialog.showMessageBox({ title: "ClaudeRipple", message: "ClaudeRipple", detail: "Run GPT and other models inside Claude Desktop, without turning Claude off.\n\nIndependent open-source project (MIT). Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC." }) },
    { label: "Quit", role: "quit" },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(s ? `ClaudeRipple ${state}` : "ClaudeRipple: router not running");
}

app.whenReady().then(() => {
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
