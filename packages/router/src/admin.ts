// Local admin API + static GUI. Binds 127.0.0.1 only, never touches the proxy port.
//
//   GET  /api/status   snapshot for the Health screen
//   GET  /api/config    raw config.json
//   PUT  /api/config    validate + atomically save config.json (router picks it up via mtime)
//   GET  /api/logs?n=   tail of router.log
//   POST /api/chatgpt-login  begin ChatGPT browser login without holding the request open
//   GET  /api/chatgpt-login  ChatGPT browser login state and credential status
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
import { resolveCompatibleCaps } from "./compat.ts";
import { ClaudeCodeAuthStore, nativeAnthropicHeaders } from "./providers/anthropic.ts";
import type { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";
import { codexEnabled, codexHome } from "../../cli/src/codex.ts";
import { openBrowser } from "../../cli/src/browser.ts";
import { caTrusted, currentAppProxy } from "../../cli/src/picker.ts";
import { ClaudeOAuthSession, type ClaudeOAuthState } from "./providers/claude-oauth.ts";
import { readClaudeAuthFile } from "./providers/anthropic-token-file.ts";

const MAX_BODY = 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();
// packages/router/src → packages/ui in a checkout; dist/router/src → dist/ui in an npm install,
// where the build copies the dashboard so this one path serves both layouts.
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
  /** Optional: observed CLI credentials held by the live proxy, never serialized directly. */
  observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
  /** Test seam for the local CLI side effects. Production uses the installed CLI runtime. */
  runCli?: (args: string[], timeout?: number) => Promise<{ ok: boolean; output: string }>;
  /** Test seam for the native Anthropic API-key probe. */
  probeFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seams for the Claude subscription sign-in: the token endpoint and the browser. */
  claudeOAuthFetch?: (url: string, init: RequestInit) => Promise<Response>;
  openBrowser?: (url: string) => boolean;
  /** Begin a graceful drain and exit. Supplied by the router; absent in tests. */
  shutdown?: () => void;
};

type ModelEntry = { id: string; name?: string; effortLevels?: string[] };
type ProbeAuth = "ok" | "bad-key" | "unreachable" | "unknown" | "missing";
type ProbeRequest = {
  type: "anthropic-compatible" | "openai-compatible";
  url: string;
  headers?: Record<string, string>;
  modelsUrl?: string;
  modelsAuthHeader?: string;
  /** Model id to use for the auth check when the provider has no listing endpoint (e.g. the preset's first fallback). */
  probeModel?: string;
};

const ANTHROPIC_EFFORT_LEVELS = ["low", "medium", "high", "max"];
const CHATGPT_DEFAULT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CHATGPT_LUNA_EFFORT_LEVELS = [...CHATGPT_DEFAULT_EFFORT_LEVELS, "ultra"];

type ChatgptLogin = { running: boolean; startedAt?: string; finishedAt?: string; ok?: boolean; output?: string };
let chatgptLogin: ChatgptLogin = { running: false };
/** The Claude subscription sign-in in progress (or the last one), for GET /api/claude-oauth. */
let claudeOAuth: ClaudeOAuthSession | null = null;

/** Shared catalog for the GUI: model-specific values override provider defaults. */
export function effortLevels(cfg: Config): { providers: Record<string, { default: string[]; models?: Record<string, string[]> }> } {
  const providers: Record<string, { default: string[]; models?: Record<string, string[]> }> = {
    anthropic: { default: ANTHROPIC_EFFORT_LEVELS },
  };
  for (const [name, provider] of Object.entries(cfg.providers)) {
    if (provider.type === "chatgpt") {
      providers[name] = {
        default: CHATGPT_DEFAULT_EFFORT_LEVELS,
        models: {
          "gpt-5.6-luna": CHATGPT_LUNA_EFFORT_LEVELS,
          "gpt-5.6-terra": CHATGPT_DEFAULT_EFFORT_LEVELS,
          "gpt-5.6-sol": CHATGPT_DEFAULT_EFFORT_LEVELS,
          "gpt-6-astra": CHATGPT_DEFAULT_EFFORT_LEVELS,
        },
      };
      continue;
    }
    const modelLevels = Object.fromEntries(
      (provider.models ?? [])
        .filter((model) => model.effortLevels !== undefined)
        .map((model) => [model.id, [...model.effortLevels!]]),
    );
    if (provider.type === "openai-compatible") {
      providers[name] = {
        default: provider.caps?.reasoning === "effort" ? (provider.caps.effortLevels ?? []) : [],
        ...(Object.keys(modelLevels).length ? { models: modelLevels } : {}),
      };
      continue;
    }
    if (provider.type === "anthropic") {
      providers[name] = { default: ANTHROPIC_EFFORT_LEVELS };
      continue;
    }
    const preset = provider.preset ? PRESETS.find((entry) => entry.id === provider.preset) : undefined;
    providers[name] = {
      default: resolveCompatibleCaps(preset ? { effortLevels: preset.effortLevels, thinking: preset.thinking } : undefined, provider.caps).effortLevels,
      ...(Object.keys(modelLevels).length ? { models: modelLevels } : {}),
    };
  }
  return { providers };
}

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

/**
 * Whether a chatgpt provider has usable credentials, from the files, so the answer is right before
 * the first request is ever made. "auto" accepts either our own login or a Codex CLI one.
 */
export function chatgptSignedIn(mode: string | undefined): boolean {
  const own = fs.existsSync(path.join(homeDir(), "chatgpt-auth.json"));
  const borrowed = fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"));
  return mode === "own" ? own : mode === "borrow-codex" ? borrowed : own || borrowed;
}

async function buildStatus(deps: AdminDeps): Promise<Record<string, unknown>> {
  const cfg = deps.config();
  const providers: Record<string, { url: string; type: string; reachable: boolean; authSource?: "observed" | "env" | "keychain" | "credentials-file" | "token-file" | null; signedIn?: "oauth" | "setup-token" | null }> = {};
  await Promise.all(
    Object.entries(cfg.providers).map(async ([name, p]) => {
      const url = p.type === "anthropic" ? "https://api.anthropic.com" : p.type === "chatgpt" ? (p.url ?? "https://chatgpt.com/backend-api") : p.url;
      let reachable = false;
      try {
        const u = new URL(url);
        reachable = await tcpReachable(u.hostname, Number(u.port) || (u.protocol === "https:" ? 443 : 80));
      } catch {
        reachable = false;
      }
      providers[name] = {
        url,
        type: p.type,
        reachable,
        // Reaching the host says nothing about being able to use it: a chatgpt provider with no
        // credentials is not "connected", and calling it that sends the user off believing it works.
        ...(p.type === "chatgpt" ? { needsLogin: !chatgptSignedIn(p.auth) } : {}),
        ...(p.type === "anthropic"
          ? {
              authSource: p.auth === "claude-code" ? claudeAuthStore(deps).describeSource() : null,
              signedIn: p.auth === "claude-code" ? (readClaudeAuthFile(homeDir())?.source ?? null) : null,
            }
          : {}),
      };
    }),
  );
  const chatgpt = deps.chatgpt?.() ?? { quota: {}, auth: {} };
  const signedIn: Record<string, boolean> = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (p.type !== "chatgpt") continue;
    signedIn[name] = chatgptSignedIn(p.auth);
  }
  const env = readSettingsEnv();
  const wantProxy = `http://127.0.0.1:${cfg.listen.port}`;
  const picker = deps.picker?.() ?? { enabled: false, hosts: [], last: null };
  // Readiness is not liveness: this process answering says nothing about whether a Claude request
  // can go through. In picker mode a missing certificate trust or app proxy entry looks, from the
  // app, exactly like a dead router. Each problem is a code the tray and the GUI can name.
  const problems: string[] = [];
  if (env.HTTPS_PROXY !== wantProxy) problems.push("settings");
  if (deps.health() > 0) problems.push("upstream");
  if (picker.enabled) {
    const trust = pickerTrust();
    if (!trust.caTrusted) problems.push("picker-ca");
    if (!trust.appProxy) problems.push("picker-proxy");
  }
  for (const [name, p] of Object.entries(providers)) if (p.reachable === false) problems.push(`provider:${name}`);
  return {
    version: deps.version,
    readiness: { ready: problems.length === 0, problems },
    // Which files this process is running, so the app can tell an old router from its own after
    // an update: a zip unpacked next to the previous install left the old one serving (2026-09-15).
    runtime: { node: process.execPath, router: process.argv[1] ?? null, startedAt: STARTED_AT },
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
    chatgpt: { ...chatgpt, signedIn },
    picker,
    agentTitle: agentTitleHookEnabled(),
    pickerModels: cfg.cli.extraModels.map((m) => m.name || m.model),
    uiRevision: uiRevision(),
  };
}

/** Certificate trust and the app's proxy entry cost a subprocess each; the tray polls every 5s, so remember them for a minute. */
let pickerTrustMemo: { at: number; value: { caTrusted: boolean; appProxy: boolean } } | null = null;
function pickerTrust(): { caTrusted: boolean; appProxy: boolean } {
  const now = Date.now();
  if (pickerTrustMemo && now - pickerTrustMemo.at < 60_000) return pickerTrustMemo.value;
  let value = { caTrusted: false, appProxy: false };
  try {
    value = { caTrusted: caTrusted(), appProxy: currentAppProxy().ours };
  } catch {
    // Unknown counts as not ready; the next poll tries again.
  }
  pickerTrustMemo = { at: now, value };
  return value;
}

/** Run the ClaudeRipple CLI with the Node that installed us (`<home>/paths.json`, written by `install`). */
function runCli(args: string[], timeout = 180_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveP) => {
    let node = process.execPath;
    // Same walk either way; the extension says which layout this file was loaded from.
    let cli = path.resolve(here, `../../cli/src/index${path.extname(fileURLToPath(import.meta.url))}`);
    let runtimeEnv: Record<string, string> = {};
    try {
      const p = JSON.parse(fs.readFileSync(path.join(homeDir(), "paths.json"), "utf8")) as { node?: string; env?: Record<string, string>; cli?: string };
      if (p.node) node = p.node;
      if (p.env) runtimeEnv = p.env;
      if (p.cli) cli = p.cli;
    } catch {
      /* not installed via the CLI: fall back to our own node + repo layout */
    }
    execFile(node, [cli, ...args], { env: { ...process.env, ...runtimeEnv, CLAUDERIPPLE_HOME: homeDir() }, timeout }, (err, stdout, stderr) => {
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

function codexState(): { enabled: boolean; codexHome: string; configPath: string } {
  const home = codexHome();
  const configPath = path.join(home, "config.toml");
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return { enabled: text.length > 0 && codexEnabled(home), codexHome: home, configPath };
  } catch {
    return { enabled: false, codexHome: home, configPath };
  }
}

function claudeAuthStore(deps: AdminDeps): ClaudeCodeAuthStore {
  return new ClaudeCodeAuthStore(undefined, { home: homeDir(), ...(deps.observedClaudeCodeAuth ? { observed: deps.observedClaudeCodeAuth } : {}) });
}

async function probeAnthropicApiKey(apiKey: string, probeFetch: (url: string, init: RequestInit) => Promise<Response> = fetchWithTimeout): Promise<{ ok: boolean; auth: ProbeAuth; models: ModelEntry[]; error?: string }> {
  const models = CLAUDE_MODEL_FALLBACK;
  const label = "messages endpoint";
  try {
    const response = await probeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...nativeAnthropicHeaders({ type: "anthropic", auth: "api-key", apiKey }) },
      body: JSON.stringify({ model: models[0]!.id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, auth: "bad-key", models, error: `${label} returned ${response.status}: ${snippet(await response.text())}` };
    if (response.ok) return { ok: true, auth: "ok", models };
    const detail = snippet(await response.text());
    if (response.status === 400 && /model.{0,80}(not.?found|invalid|unsupported|does not exist)|unknown.{0,20}model/i.test(detail)) return { ok: true, auth: "ok", models };
    if (response.status === 402 || /insufficient|balance|credit|quota|billing/i.test(detail)) return { ok: true, auth: "ok", models, error: `no-credits: ${response.status} ${detail}` };
    return { ok: false, auth: response.status >= 500 ? "unreachable" : "unknown", models, error: `${label} returned ${response.status}: ${detail}` };
  } catch (e) {
    return { ok: false, auth: "unreachable", models, error: `${label}: ${errorText(e)}` };
  }
}

function probeClaudeCodeAuth(deps: AdminDeps): { ok: boolean; auth: "ok" | "missing"; source: "observed" | "env" | "keychain" | "credentials-file" | "token-file" | null; signedIn: "oauth" | "setup-token" | null; models: ModelEntry[] } {
  const source = claudeAuthStore(deps).describeSource();
  // Our own sign-in is reported separately: a Claude Desktop session outranks it, and without this
  // the screen would answer a finished sign-in with the source it was already showing.
  return { ok: source !== null, auth: source ? "ok" : "missing", source, signedIn: readClaudeAuthFile(homeDir())?.source ?? null, models: CLAUDE_MODEL_FALLBACK };
}

function chatCompletionsUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsedModels(value: unknown): ModelEntry[] {
  const data = value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data) ? (value as { data: unknown[] }).data : [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as { id?: unknown; name?: unknown; supported_parameters?: unknown };
    if (typeof r.id !== "string") return [];
    const supported = Array.isArray(r.supported_parameters) && r.supported_parameters.every((value) => typeof value === "string")
      ? r.supported_parameters as string[]
      : undefined;
    return [{
      id: r.id,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      ...(supported ? { effortLevels: supported.includes("reasoning_effort") ? ["low", "medium", "high"] : [] } : {}),
    }];
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

  const openai = body.type === "openai-compatible";
  const checkUrl = openai ? chatCompletionsUrl(body.url) : messagesUrl(body.url);
  const checkBody = openai
    ? { model: models[0]?.id ?? body.probeModel ?? "test", max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] }
    : { model: models[0]?.id ?? body.probeModel ?? "test", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  const label = openai ? "chat completions endpoint" : "messages endpoint";
  try {
    const response = await fetchWithTimeout(checkUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(source) },
      body: JSON.stringify(checkBody),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, auth: "bad-key", models, error: `${label} returned ${response.status}: ${snippet(await response.text())}` };
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
    return { ok: false, auth: response.status >= 500 ? "unreachable" : "unknown", models, error: `${label} returned ${response.status}: ${detail}` };
  } catch (e) {
    const message = `${label}: ${errorText(e)}`;
    return { ok: false, auth: "unreachable", models, error: modelsError ? `${modelsError}; ${message}` : message };
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
    // The surfaces carry the same catalog, so "code" + "ccd" lists every model twice. And the
    // snapshot is taken *after* injection, so our own entries are in it — offering GPT ids as
    // mapping *sources* is meaningless, they are what a source maps to.
    const injected = new Set(deps.config().cli.extraModels.map((m) => m.model));
    const seen = new Set<string>();
    const models = entries.filter((e) => {
      if (injected.has(e.id) || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    if (models.length > 0) return { models, source: "picker" };
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
  // Set again once the socket is bound (port 0 in tests); the Origin check below compares against it.
  let boundPort = adminPort(deps.config());
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  /**
   * Binding to 127.0.0.1 keeps other machines out, but not the browser on this one: any page the
   * user visits can POST here, and a simple request (no custom header, no JSON content type) is
   * not stopped by CORS — the response is unreadable, the side effect still happens. That is how
   * a web page could turn the picker off, or shut the router down and take Claude Desktop with it.
   *
   * A browser always sends Origin on a cross-site POST, so requiring it to be our own origin is
   * enough. Clients that are not browsers (the CLI, the tray app) send none and are let through.
   */
  function crossSitePost(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    const allowed = new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);
    return !allowed.has(origin);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const pathname = url.split("?")[0] ?? "/";
    try {
      if (method !== "GET" && method !== "HEAD" && crossSitePost(req)) {
        deps.log.warn(`admin: refused ${method} ${pathname} from origin ${String(req.headers.origin)}`);
        sendJson(res, 403, { error: "cross-site request refused" });
        return;
      }
      if (pathname === "/api/shutdown" && method === "POST") {
        if (!deps.shutdown) {
          sendJson(res, 501, { error: "shutdown not available" });
          return;
        }
        // Answer before draining: the caller needs to know the request was accepted, and the
        // drain can outlive the connection (it waits for in-flight model calls, up to 90s).
        sendJson(res, 202, { draining: true });
        deps.shutdown();
        return;
      }
      // Liveness is answering at all; readiness is 200 only when a request can actually go through.
      if (pathname === "/readyz" && method === "GET") {
        const readiness = (await buildStatus(deps)).readiness as { ready: boolean; problems: string[] };
        if (!readiness.ready) res.setHeader("retry-after", "5");
        sendJson(res, readiness.ready ? 200 : 503, readiness);
        return;
      }
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
      if (pathname === "/api/effort-levels" && method === "GET") {
        sendJson(res, 200, effortLevels(deps.config()));
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
        const probe = parsed as { type?: unknown; auth?: unknown; apiKey?: unknown; url?: unknown; headers?: unknown; modelsUrl?: unknown; modelsAuthHeader?: unknown; probeModel?: unknown };
        if (probe.type === "anthropic") {
          if (probe.auth === "claude-code") {
            sendJson(res, 200, probeClaudeCodeAuth(deps));
            return;
          }
          if (probe.auth === "api-key") {
            const apiKey = typeof probe.apiKey === "string" && probe.apiKey.length > 0 ? probe.apiKey : process.env.ANTHROPIC_API_KEY;
            if (apiKey) {
              sendJson(res, 200, await probeAnthropicApiKey(apiKey, deps.probeFetch));
              return;
            }
          }
          sendJson(res, 400, { error: "expected {type: 'anthropic', auth: 'claude-code'|'api-key', apiKey?: string}" });
          return;
        }
        if (probe.type === "chatgpt") {
          const statuses = Object.values(deps.chatgpt?.().auth ?? {});
          const signed = chatgptSignedIn(typeof probe.auth === "string" ? probe.auth : undefined);
          sendJson(res, 200, {
            ok: signed,
            auth: signed ? (statuses[0] ?? "ok") : "missing",
            ...(signed ? {} : { error: "no ChatGPT credentials: sign in from the tray menu, or install and sign in to the Codex CLI" }),
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
          (probe.type !== "anthropic-compatible" && probe.type !== "openai-compatible") ||
          typeof probe.url !== "string" ||
          !/^https?:\/\//.test(probe.url) ||
          (probe.headers !== undefined && (!probe.headers || typeof probe.headers !== "object" || Array.isArray(probe.headers) || Object.values(probe.headers).some((v) => typeof v !== "string"))) ||
          (probe.modelsUrl !== undefined && typeof probe.modelsUrl !== "string") ||
          (probe.modelsAuthHeader !== undefined && typeof probe.modelsAuthHeader !== "string")
        ) {
          sendJson(res, 400, { error: "expected {type: 'anthropic-compatible'|'openai-compatible', url: http(s) URL, headers?: Record<string,string>, modelsUrl?: string, modelsAuthHeader?: string}" });
          return;
        }
        const result = await probeProvider({
          type: probe.type,
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
      if (pathname === "/api/codex" && method === "GET") {
        sendJson(res, 200, codexState());
        return;
      }
      if (pathname === "/api/codex" && method === "POST") {
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
        const r = await (deps.runCli ?? runCli)(["codex", enabled ? "on" : "off"]);
        deps.log.info(`admin: codex ${enabled ? "on" : "off"} via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
        return;
      }
      if (pathname === "/api/chatgpt-login" && method === "GET") {
        const provider = Object.values(deps.config().providers).find((candidate) => candidate.type === "chatgpt");
        sendJson(res, 200, { ...chatgptLogin, signedIn: chatgptSignedIn(provider?.auth) });
        return;
      }
      if (pathname === "/api/chatgpt-login" && method === "POST") {
        if (chatgptLogin.running) {
          sendJson(res, 200, { running: true });
          return;
        }
        chatgptLogin = { running: true, startedAt: new Date().toISOString() };
        deps.log.info("admin: chatgpt-login via GUI -> started");
        void (deps.runCli ?? runCli)(["login"], 330_000).then(
          (result) => {
            chatgptLogin = { ...chatgptLogin, running: false, finishedAt: new Date().toISOString(), ok: result.ok, output: result.output };
            deps.log.info(`admin: chatgpt-login via GUI -> ${result.ok ? "ok" : "failed"}`);
          },
          (error) => {
            chatgptLogin = { ...chatgptLogin, running: false, finishedAt: new Date().toISOString(), ok: false, output: errorText(error) };
            deps.log.info("admin: chatgpt-login via GUI -> failed");
          },
        );
        sendJson(res, 200, { started: true });
        return;
      }
      // Claude subscription sign-in of our own (browser, PKCE). The GUI starts it, polls the state,
      // and pastes the code when the loopback port could not be used. Tokens never leave the router.
      if (pathname === "/api/claude-oauth" && method === "GET") {
        const state: ClaudeOAuthState & { source: string | null } = { ...(claudeOAuth?.snapshot ?? { running: false, url: null, manual: false, startedAt: null, finishedAt: null, ok: null, error: null }), source: claudeAuthStore(deps).describeSource() };
        sendJson(res, 200, state);
        return;
      }
      if (pathname === "/api/claude-oauth" && method === "POST") {
        if (claudeOAuth?.snapshot.running) {
          sendJson(res, 200, claudeOAuth.snapshot);
          return;
        }
        let manual = false;
        try {
          const body = (await readBody(req)).toString("utf8");
          manual = body.length > 0 && (JSON.parse(body) as { manual?: unknown }).manual === true;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        const session = new ClaudeOAuthSession({ home: homeDir(), manual, ...(deps.claudeOAuthFetch ? { fetch: deps.claudeOAuthFetch } : {}) });
        claudeOAuth = session;
        const { url, manual: needsCode } = await session.start();
        const opened = deps.openBrowser ? deps.openBrowser(url) : openBrowser(url);
        deps.log.info(`admin: claude sign-in via GUI -> started (${needsCode ? "paste the code" : "loopback callback"}, browser ${opened ? "opened" : "not opened"})`);
        void session.result.then(
          () => deps.log.info("admin: claude sign-in via GUI -> ok"),
          (error: Error) => deps.log.info(`admin: claude sign-in via GUI -> failed: ${error.message}`),
        );
        sendJson(res, 200, { ...session.snapshot, opened });
        return;
      }
      if (pathname === "/api/claude-oauth/code" && method === "POST") {
        const session = claudeOAuth;
        if (!session?.snapshot.running) {
          sendJson(res, 409, { error: "no Claude sign-in is waiting for a code" });
          return;
        }
        let code = "";
        try {
          code = String((JSON.parse((await readBody(req)).toString("utf8")) as { code?: unknown }).code ?? "");
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        await session.submitCode(code);
        await session.result.catch(() => {});
        sendJson(res, session.snapshot.ok ? 200 : 400, session.snapshot);
        return;
      }
      if (pathname === "/api/claude-oauth/cancel" && method === "POST") {
        claudeOAuth?.cancel();
        sendJson(res, 200, claudeOAuth?.snapshot ?? { running: false });
        return;
      }
      if (pathname === "/api/claude-login" && method === "POST") {
        const r = await (deps.runCli ?? runCli)(["claude-login"], 200_000);
        deps.log.info(`admin: claude-login via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
        return;
      }
      if (pathname === "/api/claude-logout" && method === "POST") {
        const r = await (deps.runCli ?? runCli)(["claude-logout"]);
        deps.log.info(`admin: claude-logout via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
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

  const port = boundPort;
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      boundPort = addr && typeof addr === "object" ? addr.port : port;
      resolveP({
        port: boundPort,
        close(): void {
          server.close();
        },
      });
    });
  });
}
