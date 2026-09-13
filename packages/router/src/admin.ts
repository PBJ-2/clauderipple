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
import type { RequestLog } from "./requestlog.ts";
import { PRESETS, type ProviderPreset } from "./presets.ts";

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
  requests: RequestLog;
  /** Optional: chatgpt providers' latest rate-limit snapshot and credential status. */
  chatgpt?: () => { quota: Record<string, Record<string, unknown> | null>; auth: Record<string, string> };
  /** Optional: picker-mode state and the last bootstrap injection. */
  picker?: () => { enabled: boolean; hosts: string[]; last: unknown };
};

type ModelEntry = { id: string; name?: string };
type ProbeAuth = "ok" | "bad-key" | "unreachable" | "unknown";
type ProbeRequest = {
  type: "anthropic-compatible";
  url: string;
  headers?: Record<string, string>;
  modelsUrl?: string;
  modelsAuthHeader?: string;
  /** Model id to use for the auth check when the provider has no listing endpoint (e.g. the preset's first fallback). */
  probeModel?: string;
};

const CLAUDE_MODEL_FALLBACK: { id: string; name: string }[] = [
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5" },
  { id: "claude-fable-5", name: "Fable 5" },
  { id: "claude-opus-4-8", name: "Opus 4.8" },
  { id: "claude-opus-4-7", name: "Opus 4.7" },
  { id: "claude-opus-4-6", name: "Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
];


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

/** Whether ClaudeRipple's agent-title hook is registered in settings.json (see packages/cli/src/settings.ts). */
function agentTitleHookEnabled(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as { hooks?: { PreToolUse?: Record<string, unknown>[] } };
    return (s.hooks?.PreToolUse ?? []).some((e) => e._clauderipple === "agent-title");
  } catch {
    return false;
  }
}

/** Newest mtime of the served GUI files; the page reloads itself when this changes (an open window would otherwise run stale JS). */
function uiRevision(): string {
  try {
    const files = ["index.html", "app.js", "style.css", "i18n.js", "presets-fallback.js"];
    return String(Math.max(...files.map((f) => { try { return fs.statSync(path.join(UI_ROOT, f)).mtimeMs; } catch { return 0; } })));
  } catch {
    return "0";
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
    agentTitle: agentTitleHookEnabled(),
    pickerModels: cfg.cli.extraModels.map((m) => m.name || m.model),
    uiRevision: uiRevision(),
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

function headerValue(headers: Record<string, string> | undefined): { name: string; value: string } | null {
  if (!headers) return null;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if ((lower === "x-api-key" || lower === "authorization") && typeof value === "string") return { name, value };
  }
  return null;
}

function authHeaders(source: { name: string; value: string } | null, kind?: string): Record<string, string> {
  if (!source) return {};
  if (kind === "x-api-key") return { "x-api-key": source.value };
  if (kind === "authorization-bearer") return { authorization: source.value.startsWith("Bearer ") ? source.value : `Bearer ${source.value}` };
  return { [source.name]: source.value };
}

function messagesUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/messages`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsedModels(value: unknown): ModelEntry[] {
  const data = value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data) ? (value as { data: unknown[] }).data : [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as { id?: unknown; name?: unknown };
    return typeof r.id === "string" ? [{ id: r.id, ...(typeof r.name === "string" ? { name: r.name } : {}) }] : [];
  });
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
}

async function probeProvider(body: ProbeRequest): Promise<{ ok: boolean; auth: ProbeAuth; models: ModelEntry[]; error?: string }> {
  const source = headerValue(body.headers);
  let models: ModelEntry[] = [];
  let modelsError: string | undefined;
  if (body.modelsUrl) {
    try {
      const response = await fetchWithTimeout(body.modelsUrl, { headers: authHeaders(source, body.modelsAuthHeader) });
      if (response.status === 401 || response.status === 403) return { ok: false, auth: "bad-key", models: [], error: `models endpoint returned ${response.status}` };
      if (response.ok) models = parsedModels(await response.json());
      else modelsError = `models endpoint returned ${response.status}`;
    } catch (e) {
      modelsError = `models endpoint: ${errorText(e)}`;
    }
  }

  try {
    const response = await fetchWithTimeout(messagesUrl(body.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(source) },
      body: JSON.stringify({ model: models[0]?.id ?? body.probeModel ?? "test", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, auth: "bad-key", models, error: `messages endpoint returned ${response.status}: ${snippet(await response.text())}` };
    if (response.ok) return { ok: true, auth: "ok", models, ...(modelsError ? { error: modelsError } : {}) };
    const detail = snippet(await response.text());
    // A model-validation 400 still demonstrates that the endpoint reached the provider and the key was accepted.
    if (response.status === 400 && /model.{0,80}(not.?found|invalid|unsupported|does not exist)|unknown.{0,20}model/i.test(detail)) {
      return { ok: true, auth: "ok", models, ...(modelsError ? { error: modelsError } : {}) };
    }
    // Key accepted but the account cannot pay: report auth ok so the user tops up instead of re-checking the key.
    if (response.status === 402 || /insufficient|balance|credit|quota|billing/i.test(detail)) {
      return { ok: true, auth: "ok", models, error: `no-credits: ${response.status} ${detail}` };
    }
    return { ok: false, auth: response.status >= 500 ? "unreachable" : "unknown", models, error: `messages endpoint returned ${response.status}: ${detail}` };
  } catch (e) {
    const message = `messages endpoint: ${errorText(e)}`;
    return { ok: false, auth: /timeout|abort/i.test(message) ? "unreachable" : "unreachable", models, error: modelsError ? `${modelsError}; ${message}` : message };
  }
}

function pickerModels(deps: AdminDeps): { models: { id: string; name: string }[]; source: "picker" | "fallback" } {
  const last = deps.picker?.().last;
  if (last && typeof last === "object" && Array.isArray((last as { surfaces?: unknown }).surfaces)) {
    const entries = (last as { surfaces: { id?: unknown; entries?: unknown }[] }).surfaces
      .filter((surface) => surface.id === "code" || surface.id === "ccd")
      .flatMap((surface) => (Array.isArray(surface.entries) ? surface.entries : []))
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const r = entry as { id?: unknown; name?: unknown };
        return typeof r.id === "string" ? [{ id: r.id, name: typeof r.name === "string" ? r.name : r.id }] : [];
      });
    if (entries.length > 0) return { models: entries, source: "picker" };
  }
  return { models: CLAUDE_MODEL_FALLBACK, source: "fallback" };
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
      if (pathname === "/api/presets" && method === "GET") {
        sendJson(res, 200, { presets: PRESETS satisfies ProviderPreset[] });
        return;
      }
      if (pathname === "/api/claude-models" && method === "GET") {
        sendJson(res, 200, pickerModels(deps));
        return;
      }
      if (pathname === "/api/providers/probe" && method === "POST") {
        let raw: Buffer;
        try {
          raw = await readBody(req);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          sendJson(res, 400, { error: "expected provider probe object" });
          return;
        }
        const probe = parsed as { type?: unknown; url?: unknown; headers?: unknown; modelsUrl?: unknown; modelsAuthHeader?: unknown; probeModel?: unknown };
        if (probe.type === "chatgpt") {
          const statuses = Object.values(deps.chatgpt?.().auth ?? {});
          sendJson(res, 200, {
            ok: true,
            auth: statuses[0] ?? "unknown",
            models: [
              { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
              { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
              { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
              { id: "gpt-6-astra", name: "GPT-6 Astra" },
            ],
          });
          return;
        }
        if (
          probe.type !== "anthropic-compatible" ||
          typeof probe.url !== "string" ||
          !/^https?:\/\//.test(probe.url) ||
          (probe.headers !== undefined && (!probe.headers || typeof probe.headers !== "object" || Array.isArray(probe.headers) || Object.values(probe.headers).some((v) => typeof v !== "string"))) ||
          (probe.modelsUrl !== undefined && typeof probe.modelsUrl !== "string") ||
          (probe.modelsAuthHeader !== undefined && typeof probe.modelsAuthHeader !== "string")
        ) {
          sendJson(res, 400, { error: "expected {type: 'anthropic-compatible', url: http(s) URL, headers?: Record<string,string>, modelsUrl?: string, modelsAuthHeader?: string}" });
          return;
        }
        const result = await probeProvider({
          type: "anthropic-compatible",
          url: probe.url,
          ...(probe.headers ? { headers: probe.headers as Record<string, string> } : {}),
          ...(probe.modelsUrl ? { modelsUrl: probe.modelsUrl } : {}),
          ...(probe.modelsAuthHeader ? { modelsAuthHeader: probe.modelsAuthHeader } : {}),
          ...(typeof probe.probeModel === "string" ? { probeModel: probe.probeModel } : {}),
        });
        sendJson(res, 200, result);
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
      if (pathname === "/api/agent-title" && method === "POST") {
        // Registers/removes the PreToolUse hook that prefixes subagent titles with the real model.
        let enabled: unknown;
        try {
          enabled = (JSON.parse((await readBody(req)).toString("utf8")) as { enabled?: unknown }).enabled;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (typeof enabled !== "boolean") {
          sendJson(res, 400, { error: "expected {enabled: boolean}" });
          return;
        }
        const r = await runCli(["agent-title", enabled ? "on" : "off"]);
        deps.log.info(`admin: agent-title ${enabled ? "on" : "off"} via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
        return;
      }
      if (pathname === "/api/requests" && method === "GET") {
        const query = new URL(url, "http://x").searchParams;
        const requested = Number(query.get("n") ?? 200);
        const n = Number.isFinite(requested) ? Math.min(2000, Math.max(1, Math.floor(requested))) : 200;
        const provider = query.get("provider") || undefined;
        const kindValue = query.get("kind");
        const kind = kindValue === "messages" || kindValue === "count_tokens" || kindValue === "other" ? kindValue : undefined;
        sendJson(res, 200, { requests: deps.requests.list(n, { ...(provider ? { provider } : {}), ...(kind ? { kind } : {}) }) });
        return;
      }
      if (pathname === "/api/requests/summary" && method === "GET") {
        const seconds = Number(new URL(url, "http://x").searchParams.get("since") ?? 3600);
        const safeSeconds = Number.isFinite(seconds) ? Math.min(31_536_000, Math.max(0, seconds)) : 3600;
        sendJson(res, 200, deps.requests.summary(Date.now() - safeSeconds * 1000));
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
