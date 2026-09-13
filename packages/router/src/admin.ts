// Local admin API + static GUI. Binds 127.0.0.1 only, never touches the proxy port.
//
//   GET  /api/status   snapshot for the Health screen
//   GET  /api/config    raw config.json
//   PUT  /api/config    validate + atomically save config.json (router picks it up via mtime)
//   GET  /api/logs?n=   tail of router.log
//   GET  /*             static files from packages/ui (the GUI itself)

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { homeDir, validate } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Stats } from "./proxy.ts";

const MAX_BODY = 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(here, "../../ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export type AdminDeps = {
  config: () => Config;
  configFile: string;
  log: Logger;
  stats: () => Stats;
  health: () => number;
  version: string;
  /** Optional: chatgpt providers' latest rate-limit snapshot and credential status. */
  chatgpt?: () => { quota: Record<string, Record<string, unknown> | null>; auth: Record<string, string> };
  /** Optional: picker-mode state and the last bootstrap injection. */
  picker?: () => { enabled: boolean; hosts: string[]; last: unknown };
};

export function adminPort(cfg: Config): number {
  return cfg.admin?.port ?? cfg.listen.port + 1;
}

function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? path.join(os.homedir(), ".claude", "settings.json");
}

function readSettingsEnv(): { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string } {
  try {
    const text = fs.readFileSync(settingsPath(), "utf8");
    if (text.trim() === "") return {};
    const s = JSON.parse(text) as { env?: Record<string, string> };
    const env = s.env ?? {};
    const out: { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string } = {};
    if (env.HTTPS_PROXY !== undefined) out.HTTPS_PROXY = env.HTTPS_PROXY;
    if (env.NODE_EXTRA_CA_CERTS !== undefined) out.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
    return out;
  } catch {
    return {};
  }
}

function cliVersion(): string {
  const dir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = fs
      .readdirSync(dir)
      .filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.length ? versions[versions.length - 1]! : "none";
  } catch {
    return "n/a";
  }
}

function tcpReachable(hostname: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolveP) => {
    const sock = net.connect({ host: hostname, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolveP(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolveP(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolveP(false);
    });
  });
}

async function buildStatus(deps: AdminDeps): Promise<Record<string, unknown>> {
  const cfg = deps.config();
  const providers: Record<string, { url: string; type: string; reachable: boolean }> = {};
  await Promise.all(
    Object.entries(cfg.providers).map(async ([name, p]) => {
      const url = p.url ?? "https://chatgpt.com/backend-api";
      let reachable = false;
      try {
        const u = new URL(url);
        reachable = await tcpReachable(u.hostname, Number(u.port) || (u.protocol === "https:" ? 443 : 80));
      } catch {
        reachable = false;
      }
      providers[name] = { url, type: p.type, reachable };
    }),
  );
  const chatgpt = deps.chatgpt?.() ?? { quota: {}, auth: {} };
  const env = readSettingsEnv();
  const wantProxy = `http://127.0.0.1:${cfg.listen.port}`;
  return {
    version: deps.version,
    home: homeDir(),
    listen: cfg.listen,
    upstream: cfg.upstream,
    adminPort: adminPort(cfg),
    stats: deps.stats(),
    consecutiveUpstreamFailures: deps.health(),
    routes: Object.keys(cfg.routes).length,
    providers,
    settings: {
      HTTPS_PROXY: env.HTTPS_PROXY ?? null,
      NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? null,
      pointsAtRouter: env.HTTPS_PROXY === wantProxy,
    },
    cliVersion: cliVersion(),
    chatgpt,
    picker: deps.picker?.() ?? { enabled: false, hosts: [], last: null },
  };
}

/** Run the ClaudeRipple CLI with the Node that installed us (`<home>/paths.json`, written by `install`). */
function runCli(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveP) => {
    let node = process.execPath;
    let cli = path.resolve(here, "../../cli/src/index.ts");
    try {
      const p = JSON.parse(fs.readFileSync(path.join(homeDir(), "paths.json"), "utf8")) as { node?: string; cli?: string };
      if (p.node) node = p.node;
      if (p.cli) cli = p.cli;
    } catch {
      /* not installed via the CLI: fall back to our own node + repo layout */
    }
    execFile(node, [cli, ...args], { env: { ...process.env, CLAUDERIPPLE_HOME: homeDir() }, timeout: 180_000 }, (err, stdout, stderr) => {
      resolveP({ ok: !err, output: `${stdout}${stderr}${err ? `\n${err.message}` : ""}`.trim() });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveP(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const out = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(out)) });
  res.end(out);
}

function tailLines(file: string, n: number): string {
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  // last line is usually "" from trailing \n; keep behavior simple and predictable
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length ? "\n" : "");
}

function safeStaticPath(urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = path.resolve(UI_ROOT, rel);
  const rootWithSep = UI_ROOT.endsWith(path.sep) ? UI_ROOT : UI_ROOT + path.sep;
  if (full !== UI_ROOT && !full.startsWith(rootWithSep)) return null; // path traversal guard
  return full;
}

function serveStatic(urlPath: string, res: http.ServerResponse): void {
  const full = safeStaticPath(urlPath);
  if (!full) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // SPA-ish fallback: unknown paths under / serve index.html so the GUI can route itself
      if (!path.extname(full)) {
        const index = path.join(UI_ROOT, "index.html");
        fs.readFile(index, (err2, data) => {
          if (err2) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          res.writeHead(200, { "content-type": MIME[".html"]! });
          res.end(data);
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(full);
    const type = MIME[ext] ?? "application/octet-stream";
    fs.readFile(full, (err2, data) => {
      if (err2) {
        sendJson(res, 500, { error: "read failed" });
        return;
      }
      res.writeHead(200, { "content-type": type, "content-length": String(data.length) });
      res.end(data);
    });
  });
}

export function startAdmin(deps: AdminDeps): Promise<{ port: number; close(): void }> {
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const pathname = url.split("?")[0] ?? "/";
    try {
      if (pathname === "/api/status" && method === "GET") {
        sendJson(res, 200, await buildStatus(deps));
        return;
      }
      if (pathname === "/api/config" && method === "GET") {
        sendJson(res, 200, deps.config());
        return;
      }
      if (pathname === "/api/config" && method === "PUT") {
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        let parsed: Config;
        try {
          parsed = JSON.parse(body.toString("utf8")) as Config;
        } catch (e) {
          sendJson(res, 400, { errors: [`invalid JSON: ${(e as Error).message}`] });
          return;
        }
        const errors = validate(parsed);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        const tmp = `${deps.configFile}.tmp-${process.pid}-${Date.now()}`;
        fs.mkdirSync(path.dirname(deps.configFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n");
        fs.renameSync(tmp, deps.configFile);
        deps.log.info(`admin: config saved via GUI (${Object.keys(parsed.routes).length} routes, ${Object.keys(parsed.providers).length} providers)`);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === "/api/picker" && method === "POST") {
        // Runs `clauderipple picker on|off` (keychain trust, app Config Library, config flag).
        // macOS shows its keychain password dialog in the user's session; we never see the password.
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        let enabled: unknown;
        try {
          enabled = (JSON.parse(body.toString("utf8")) as { enabled?: unknown }).enabled;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (typeof enabled !== "boolean") {
          sendJson(res, 400, { error: "expected {enabled: boolean}" });
          return;
        }
        const r = await runCli(["picker", enabled ? "on" : "off"]);
        deps.log.info(`admin: picker ${enabled ? "on" : "off"} via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
        return;
      }
      if (pathname === "/api/logs" && method === "GET") {
        const n = Number(new URL(url, "http://x").searchParams.get("n") ?? 200) || 200;
        const file = path.join(homeDir(), "logs", "router.log");
        const text = tailLines(file, n);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
        return;
      }
      if (method === "GET") {
        serveStatic(pathname, res);
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      deps.log.error(`admin error: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
      else res.destroy();
    }
  }

  const port = adminPort(deps.config());
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      resolveP({
        port: boundPort,
        close(): void {
          server.close();
        },
      });
    });
  });
}
