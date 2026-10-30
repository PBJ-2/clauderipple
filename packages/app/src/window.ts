// The app's one window: the whole dashboard, served from the app itself (protocol.ts), so it opens
// and can repair things with the router dead. A preload bridge (preload.ts) gives the dashboard the
// few things only the app can do: doctor, repair, the direct switch, reopening Claude.

import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";

import { ORIGIN } from "./protocol";

export type Bounds = { x: number; y: number; width: number; height: number };

const DEFAULT = { width: 1040, height: 740 };
const MIN = { width: 760, height: 540 };

let win: BrowserWindow | null = null;

export type WindowDeps = {
  lang: string;
  /** Where the window was last time, if it still fits a screen. */
  savedBounds: () => Bounds | null;
  saveBounds: (bounds: Bounds) => void;
  /** The window came up or was brought forward. */
  shown: () => void;
};

/** A saved position is used only if most of it is still on some display (a monitor may be gone). */
function fits(b: Bounds): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= Math.min(200, b.width) && h >= Math.min(120, b.height);
  });
}

function isOurs(url: string): boolean {
  return url.startsWith(`${ORIGIN}/`) || url === ORIGIN;
}

/**
 * Opens the window, or brings it forward. `view` is a dashboard section ("health", "slots", …):
 * the tray asks for "health" when something is wrong.
 */
export function openWindow(deps: WindowDeps, view?: string): void {
  if (win && !win.isDestroyed()) {
    if (view) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${view}`)}`).catch(() => undefined);
    if (win.isMinimized()) win.restore();
    win.show();
    focusApp();
    win.focus();
    deps.shown();
    return;
  }
  const saved = deps.savedBounds();
  const bounds = saved && fits(saved) ? saved : null;
  const mac = process.platform === "darwin";
  win = new BrowserWindow({
    ...(bounds ?? DEFAULT),
    minWidth: MIN.width,
    minHeight: MIN.height,
    show: false,
    title: "ClaudeRipple",
    // The dashboard's own sidebar sits under the traffic lights; elsewhere the system frame stays.
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    // Its first frame is the page's own background, not a white flash in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7",
    autoHideMenuBar: true,
    // The app icon (macOS takes it from the bundle): Windows reads every size from the .ico.
    icon: mac ? undefined : path.join(__dirname, "..", "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (!mac) win.removeMenu();
  // Links the dashboard opens (release notes, sign-in pages) belong in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  const remember = () => {
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) deps.saveBounds(win.getNormalBounds());
  };
  win.on("resized", remember);
  win.on("moved", remember);
  win.on("close", remember);
  win.once("ready-to-show", () => {
    win?.show();
    focusApp();
    win?.focus();
    dockIcon();
  });
  win.on("closed", () => {
    win = null;
    // A tray app again once its window is gone.
    if (mac) app.dock?.hide();
  });
  if (mac) {
    // The window's Dock icon is the running bundle's. npm installs run our own ClaudeRipple.app,
    // but a checkout or a runtime fetched before that still runs Electron.app, whose Dock icon is
    // the atom (2026-10-20). Ours is set on it whatever bundle runs, once the Dock icon is up: set
    // while the app had none, it was dropped when show() put the bundle's back.
    void app.dock?.show().then(dockIcon);
  }
  void win.loadURL(`${ORIGIN}/?lang=${encodeURIComponent(deps.lang)}${view ? `#${view}` : ""}`);
  deps.shown();
}

/**
 * Our icon on the Dock, on macOS: set again once the window shows, which put the bundle's back. Set
 * right after a launch from the app's icon, macOS put Electron's back once the launch finished
 * (two calls with the Dock visible, both lost; 2026-10-20), so it is set once more 2s later.
 */
function dockIcon(): void {
  if (process.platform !== "darwin") return;
  const set = (): void => app.dock?.setIcon(path.join(__dirname, "..", "assets", "icon.png"));
  set();
  setTimeout(set, 2_000).unref();
}

/** When the window last asked LaunchServices to bring the app forward (see focusApp). */
let lastLaunchServicesFocus = 0;

/**
 * The tray app has no Dock icon until a window opens, so a window opened from it could come up behind the frontmost app.
 *
 * macOS 14+ activation is cooperative: `steal` is ignored unless the active app yields, so a window
 * opened from the launcher icon (a second instance) or the tray menu came up behind other apps and
 * the app never became frontmost — the icon looked like it did nothing, and BetterTouchTool's
 * move-to-other-display acted on the frontmost app instead (2026-10-30, `lsappinfo front` +
 * CGWindowList). LaunchServices opening our own bundle is honoured, so when the window is still not
 * focused a moment later, `open` the bundle once; the reopen it sends lands in `activate` (main.ts).
 */
function focusApp(): void {
  if (process.platform !== "darwin") return;
  app.focus({ steal: true });
  setTimeout(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isFocused()) return;
    if (Date.now() - lastLaunchServicesFocus < 5_000) return;
    lastLaunchServicesFocus = Date.now();
    const bundle = ownBundle();
    if (bundle) execFile("/usr/bin/open", ["-a", bundle], () => undefined);
  }, 400).unref();
}

/** The .app this process runs from (…/Name.app/Contents/MacOS/<exe>), or null outside a bundle. */
function ownBundle(): string | null {
  const exe = app.getPath("exe");
  const marker = `.app${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const at = exe.lastIndexOf(marker);
  return at < 0 ? null : exe.slice(0, at + 4);
}

export function mainWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function windowVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

/** Sends the bridge's state to the page, if the window is open. */
export function sendToWindow(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
