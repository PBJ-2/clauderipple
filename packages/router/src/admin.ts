// Local admin API + static GUI. Binds 127.0.0.1 only, never touches the proxy port.
//
//   GET  /api/status   snapshot for the Health screen
//   GET  /api/config    raw config.json
//   PUT  /api/config    validate + atomically save config.json (router picks it up via mtime)
//   GET  /api/logs?n=   tail of router.log
//   POST /api/chatgpt-login  begin ChatGPT browser login (adds an account) without holding the request open
//   GET  /api/chatgpt-login  ChatGPT browser login state and credential status
//   GET  /api/chatgpt-accounts?provider=   signed-in ChatGPT accounts, rotation state, quota (no tokens)
//   PATCH/DELETE /api/chatgpt-accounts/:id rename, pause/resume, clear a cooldown; remove
//   POST /api/google-login   begin a Google (Antigravity) browser sign-in; GET polls the state
//   POST /api/google-login/code  paste the code when no loopback callback could be used
//   GET  /api/google-accounts?provider=   signed-in Google accounts, rotation state (no tokens)
//   PATCH/DELETE /api/google-accounts/:id rename, pause/resume, clear a cooldown; remove
//   GET  /api/update    whether a newer version is published, and how this copy was installed
//   POST /api/update    start `clauderipple update` in the background (it restarts this router)
//   GET  /api/power     lid-closed awake + hotspot failover state (power.ts)
//   PUT  /api/power     change awake mode/until, tether on/off (saved), pin (in memory)
//   POST /api/power/setup  start `clauderipple awake setup [--ssid]` (macOS password dialog); GET polls it
//   GET  /*           static files from packages/ui (the GUI itself)

import crypto from "node:crypto";
import { phoneRequest } from "./phone.ts";
import { settingsId, validSettingsJobAction } from "../../remote/src/settings-jobs.ts";
import type { PhoneDeps } from "./phone.ts";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runCli, startCliDetached, parseUpdateCheck, type DetachedCli } from "./cli-control.ts";
import { AutoUpdater } from "./autoupdate.ts";
export { parseUpdateCheck, type UpdateCheck } from "./cli-control.ts";
import { fileURLToPath } from "node:url";
import type { Config, Provider, ProviderCredential, ProviderModel } from "./config.ts";
import { withFileLock } from "./locked-file.ts";
import { adminPort, headerValueProblem, homeDir, searchProviderFor, ssidProblem, validate } from "./config.ts";
export { adminPort } from "./config.ts";
import { agentRenames, generatedAgents } from "./agents.ts";
import { isJudgeOnlyModel } from "./model-policy.ts";
import { ModSettingsInputError, readModSettings, validateSettings, validateSettingsSchema, writeAutoCompactWindow, writeModSettings } from "./mod-settings.ts";
import { billingOf, claudeChoices, fillLadder, ladderNeedsFill } from "../../mod/hooks/ladder.ts";
import { normalizeSettings, twoLevelRungs } from "../../mod/hooks/settings.ts";
import type { Billing, DomainRules, Effort, LadderChoice, Rungs, Settings, Step } from "../../mod/types/index.d.ts";
import { chatPickerModels } from "./picker.ts";
import { declaredBy, resolve } from "./routing.ts";
import type { Logger } from "./log.ts";
import { CredentialPool } from "./pool.ts";
import { ClaudeAccountAuthPool } from "./providers/anthropic-account-pool.ts";
import type { ModelHealth, ProviderExhaustion } from "./health.ts";
import type { Stats } from "./proxy.ts";
import type { RequestLog } from "./requestlog.ts";
import { PRESETS, type ProviderPreset } from "./presets.ts";
import { answersWebSearch, effortLevels, targetWarnings } from "./targets.ts";
export { effortLevels } from "./targets.ts";
import { redactErrorText } from "./redact.ts";
import { CHATGPT_FALLBACK_MODELS } from "./providers/chatgpt/catalog.ts";
import { contextWindowSnapshot, syncContextWindows } from "./context-windows.ts";
import { measureModel, ollamaApiBase, ollamaModelFacts, refusedByPlan, type Measured, type WireCandidate } from "./capabilities.ts";
import { catalogEntry, catalogueWindow } from "./catalog.ts";
import { ModelScoreCatalog, buildModelScores } from "./model-scores.ts";
import { ClaudeCodeAuthStore, nativeAnthropicHeaders, type ClaudeCodeCredentialReaders } from "./providers/anthropic.ts";
import type { ObservedClaudeCodeAuth } from "./providers/anthropic-observed.ts";
import { fetchClaudeModels, newClaudeReleases, type ClaudeModel } from "./providers/anthropic-models.ts";
import { codexEnabled, codexHome } from "../../cli/src/codex.ts";
import { openBrowser } from "../../cli/src/browser.ts";
import { caTrusted, currentAppProxy } from "../../cli/src/picker.ts";
import { certPaths } from "../../cli/src/certs.ts";
import { desktopClaudeCodeDirs } from "../../cli/src/claude-auth.ts";
import { statusModEnabled, syncModelSlots } from "../../cli/src/settings.ts";
import { ClaudeOAuthSession, type ClaudeOAuthState } from "./providers/claude-oauth.ts";
import { readClaudeAuthFile } from "./providers/anthropic-token-file.ts";
import { listClaudeAccounts, listClaudeAccountsWithSubject, removeClaudeAccount, updateClaudeAccount, setPreferredClaudeAccount } from "./providers/anthropic-accounts.ts";
import { readChatGptAccounts, removeChatGptAccount, summarize as summarizeChatGptAccount, updateChatGptAccount } from "./providers/chatgpt/accounts.ts";
import { exhaustedForMs, IMAGE_ASPECTS, IMAGE_BACKGROUNDS, IMAGE_FORMATS, type ChatGptAccountStatus, type ImageRequest, type ImageResult } from "./providers/chatgpt/index.ts";
import type { GoogleAccountStatus } from "./providers/google/index.ts";
import { googleWindowsFromGroups, type QuotaGroup } from "./providers/google/usage.ts";
import { isOpenCodeGo, type OpenCodeWindow } from "./providers/opencode-usage.ts";
import type { GrokWindow } from "./providers/grok/usage.ts";
import { ANTIGRAVITY_WARNING, staticAntigravityModels } from "./providers/google/antigravity.ts";
import { readGoogleAccounts, removeGoogleAccount, summarize as summarizeGoogleAccount, updateGoogleAccount } from "./providers/google/accounts.ts";
import { GoogleOAuthSession, type GoogleOAuthState } from "./providers/google/login.ts";
import { GROK_AUTH_HINT, grokAuthPath, grokHome, readGrokToken, sharedGrokAuth } from "./providers/grok/auth.ts";
import { GROK_DEFAULT_URL, GROK_FALLBACK_MODELS, grokModelsFromListing } from "./providers/grok/catalog.ts";
import { GROK_WARNING, grokHeaders } from "./providers/grok/index.ts";
import type { TunnelStatus } from "./remote-tunnel.ts";
import { parsePowerChange, persistPowerChange, type PowerApi } from "./power.ts";
import { processPriorityState, type ProcessPriorityState } from "./process-priority.ts";

const MAX_BODY = 1024 * 1024;
/** `/api/image` carries reference images inline, so it gets more room than a config save. */
const MAX_IMAGE_BODY = 32 * 1024 * 1024;
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
  /** External boundaries for the host-local control bridge; no production side effects in tests. */
  phone?: PhoneDeps;
  config: () => Config;
  configFile: string;
  /**
   * Validation errors from the config file as last read. An invalid file is still adopted on the
   * first read so the router can serve the fix, but readiness must not call that healthy (G-D14).
   */
  configErrors?: () => string[];
  log: Logger;
  stats: () => Stats;
  health: () => number;
  processPriority?: () => ProcessPriorityState;
  providerHealth?: () => Record<string, ProviderExhaustion>;
  modelHealth?: ModelHealth["snapshot"];
  version: string;
  /**
   * The installation identity this process captured at start: its home's opaque id (immutable for
   * this process, even if the file changes) and its own pid. Status reports both, and a shutdown
   * request is accepted only from the installation this process actually is (B01/D6).
   */
  instance?: { installId: string | null; pid: number };
  requests: RequestLog;
  /** Optional: chatgpt providers' latest rate-limit snapshot and credential status. */
  chatgpt?: () => {
    quota: Record<string, Record<string, unknown> | null>;
    auth: Record<string, string>;
    /** Active quota lookup by provider name; absent in tests. Returns null on failure. */
    refresh?: (name: string) => Promise<Record<string, unknown> | null>;
    /**
     * The models one chatgpt provider can reach, from the Codex backend's own catalogue. Null when
     * the catalogue cannot be read or the provider is not configured — the caller then shows its
     * measured fallback list. Absent in tests.
     */
    models?: (name: string) => Promise<ProviderModel[] | null>;
    /** Every chatgpt provider's accounts with rotation state and quota. Absent in tests. */
    accounts?: () => Record<string, ChatGptAccountStatus[]>;
    /** Put one resting account back into rotation now. Absent in tests. */
    clearCooldown?: (accountId: string) => void;
  };
  /** Optional: google (Antigravity) providers' accounts and catalogue. Absent in tests. */
  google?: () => {
    /** Every antigravity provider's accounts with rotation state. Never a token. */
    accounts: () => Record<string, GoogleAccountStatus[]>;
    /** The models one antigravity provider can reach, from Cloud Code Assist's own catalogue. */
    models?: (name: string) => Promise<ProviderModel[] | null>;
    /** Each antigravity account's quota groups by owner id, for the status bar's limits row (`/api/limits`). Absent in tests. */
    usage?: (name: string) => Promise<Record<string, QuotaGroup[]>>;
    /** The pool scope a turn for one model rests in (its quota group on its host), the key of `quotaCooldowns`. */
    quotaScope?: (name: string, model: string) => string | undefined;
    /** Put one resting account back into rotation now. */
    clearCooldown?: (accountId: string) => void;
    /** Ask Google again whether an account still needs its verification page. */
    recheckVerification?: (accountId: string) => Promise<"verified" | "still-required" | "unknown">;
  };
  /** Test seam for the Google sign-in: the token/userinfo/CCA endpoints. */
  googleOAuthFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Test seam: the loopback port the Google sign-in binds instead of the Antigravity default. */
  googleOAuthPort?: number;
  /**
   * Optional: per-credential cooldowns and quarantines, for providers that declare a pool. Ids and
   * labels only — never a header value.
   */
  credentials?: () => Record<string, { id: string; label?: string; state: string; cooldownSeconds?: number; failures: number; paused?: boolean; preferred?: boolean; inUse?: boolean }[]>;
  clearCredentialCooldown?: (provider: string, id: string) => void;
  claudeClearCooldown?: (id: string) => void;
  /** Optional: picker-mode state and the last bootstrap injection. */
  picker?: () => { enabled: boolean; hosts: string[]; last: unknown };
  /** Optional: observed CLI credentials held by the live proxy, never serialized directly. */
  observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
  /** Test seam for Claude Code's keychain and credential-file readers. */
  claudeCodeCredentialReaders?: ClaudeCodeCredentialReaders;
  /** Test seam for the local CLI side effects. Production uses the installed CLI runtime. */
  runCli?: (args: string[], timeout?: number) => Promise<{ ok: boolean; output: string }>;
  /** Test seam for a CLI run that must outlive this router (the update). */
  startCliDetached?: (args: string[], log: string, env?: NodeJS.ProcessEnv) => DetachedCli | void;
  autoUpdater?: AutoUpdater;
  /** Test seam for the native Anthropic API-key probe. */
  probeFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seam for a provider model probe (`POST /api/providers/probe`), which in production uses a timeout. */
  probeModelFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seam for the background capability measurement. Production uses a timeout-wrapped fetch. */
  measureFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The public model catalogue (models.dev) a measurement reads before asking. Supplied by the
   * router; absent in tests, which then measure everything by request as before. */
  modelCatalog?: () => Promise<unknown>;
  /** Agent directory boundary; defaults to ~/.claude/agents, isolated in admin tests. */
  agentDir?: string;
  /** External AA dataset fetch boundary; the same cache/TTL is used in tests and production. */
  modelScoresFetch?: typeof fetch;
  /** Test seams for the Claude subscription sign-in: the token endpoint and the browser. */
  claudeOAuthFetch?: (url: string, init: RequestInit) => Promise<Response>;
  openBrowser?: (url: string) => boolean;
  /** Begin a graceful drain and exit. Supplied by the router; absent in tests. */
  shutdown?: () => void;
  /** One image through the ChatGPT subscription (`POST /api/image`). */
  image?: (req: ImageRequest, signal: AbortSignal, meta?: { session?: string }) => Promise<ImageResult>;
  /**
   * Usage of each Claude subscription account, keyed by owner id ("current" for the Claude Code
   * login, otherwise the account id `/api/claude-accounts` lists). Absent in tests.
   */
  claudeUsage?: () => Promise<Record<string, Record<string, unknown>>>;
  /**
   * The current Claude login's own account: its email and the pool's one-way subject hash, so a
   * stored account that is the same person is not listed as a second one (`/api/claude-accounts`).
   * Null when the login's identity is unknown. Absent in tests.
   */
  claudeIdentity?: () => Promise<{ email: string; subjectHash: string } | null>;
  /** The Claude models the signed-in account can use (`GET /v1/models`); null until one answer. Absent in tests. */
  claudeModels?: () => Promise<ClaudeModel[] | null>;
  /** An OpenCode Go provider's usage windows, for the status bar's limits row (`/api/limits`). Absent in tests. */
  opencodeUsage?: (name: string, credentialId?: string) => Promise<OpenCodeWindow[]>;
  /** A Grok provider's usage pool, for the status bar's limits row (`/api/limits`). Absent in tests. */
  grokUsage?: (name: string) => Promise<GrokWindow[]>;
  /**
   * Reverse SSH tunnels to remote hosts (remote-tunnel.ts): `GET /api/remote` reports them,
   * `POST /api/remote/reload` re-reads `remote.hosts` from the config (after `remote add|remove`).
   */
  remote?: { status: () => TunnelStatus[]; reload: () => TunnelStatus[] };
  /** Lid-closed awake and hotspot failover (`GET|PUT /api/power`). Absent: 501. */
  power?: PowerApi;
};

/** Without a configured adapter there is no runtime cooldown, but account previews still name the next choice. */
function previewAccounts<T extends { id: string; paused: boolean; preferred: boolean; needsReauth: boolean; expiresAt: number }>(accounts: T[]): (T & { state: string; inUse: boolean })[] {
  const credentials = accounts.filter((account) => !account.paused && !account.needsReauth && account.expiresAt > Date.now())
    .map((account) => ({ id: account.id, preferred: account.preferred, headers: {} }));
  const next = new CredentialPool().pick("preview", credentials)?.id;
  return accounts.map((account) => ({ ...account, state: account.paused ? "paused" : credentials.some((credential) => credential.id === account.id) ? "ready" : "needs-login", inUse: account.id === next }));
}

/** Claude usage is looked up only where a Claude subscription provider is configured. */
function hasClaudeSubscription(cfg: Config): boolean {
  return Object.values(cfg.providers).some((p) => p.type === "anthropic" && p.auth === "claude-code");
}

/**
 * One row per Claude account with a known usage, current login first. Labels only: the status is
 * polled every few seconds and has no use for an email address.
 */
async function claudeAccountUsage(deps: AdminDeps): Promise<{ id: string; label: string; quota: Record<string, unknown> }[]> {
  let usage: Record<string, Record<string, unknown>>;
  try {
    usage = (await deps.claudeUsage?.()) ?? {};
  } catch {
    return [];
  }
  const rows: { id: string; label: string; quota: Record<string, unknown> }[] = [];
  if (usage.current) rows.push({ id: "current", label: "Current Claude login", quota: usage.current });
  for (const account of listClaudeAccounts(homeDir())) {
    const quota = usage[account.id];
    if (quota) rows.push({ id: account.id, label: account.label, quota });
  }
  return rows;
}

// ---- Limits (`GET /api/limits`) ----------------------------------------------------------------
//
// One shape for every provider whose quota can be read, so the status bar's second row instrument
// them all the same way: Claude's plan windows and per-model weeklies, each ChatGPT account's
// windows, each Antigravity account's Gemini and third-party windows, OpenCode Go's three windows
// and a Grok subscription's usage pool. Providers with no way to read a quota (OpenCode Zen, the
// compatible APIs) are simply not listed, and a provider
// saved with `limits: false` opts out. Read in the provider's config order; the mod keeps Claude
// first and otherwise follows this order.

/** One window the limits row reads. `reset_at` is epoch seconds, as the other readers use. */
export type LimitsWindow = { kind: "five_hour" | "seven_day" | "scoped" | "window"; label?: string; used_percent: number; window_minutes?: number; reset_at?: number };
export type LimitsAccount = { account: number; label?: string; windows: LimitsWindow[]; at: number };
export type LimitsProvider = { provider: string; type: string; title: string; accounts: LimitsAccount[] };

/** A `{used_percent, window_minutes, reset_at}` snapshot window as `/api/limits` reads it, or null. */
function limitWindowFrom(w: unknown): { used_percent: number; window_minutes?: number; reset_at?: number } | null {
  if (!w || typeof w !== "object" || Array.isArray(w)) return null;
  const o = w as Record<string, unknown>;
  const used = o.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const minutes = typeof o.window_minutes === "number" && o.window_minutes > 0 ? o.window_minutes : undefined;
  // A reset already in milliseconds would otherwise park a window for decades; the other readers
  // normalise the same way (chatgpt windowResetMs).
  const reset = typeof o.reset_at === "number" && Number.isFinite(o.reset_at) ? Math.round(o.reset_at > 1e12 ? o.reset_at / 1000 : o.reset_at) : undefined;
  return { used_percent: used, ...(minutes !== undefined ? { window_minutes: minutes } : {}), ...(reset !== undefined ? { reset_at: reset } : {}) };
}

/** The kind a five-hour/weekly/other window takes, by its length in minutes. */
function windowKind(minutes: number | undefined): "five_hour" | "seven_day" | "window" {
  return minutes === 300 ? "five_hour" : minutes === 10080 ? "seven_day" : "window";
}

/** One Claude subscription account's plan windows: the two main windows and the scoped weeklies. */
function claudeLimitWindows(quota: Record<string, unknown>): LimitsWindow[] {
  const out: LimitsWindow[] = [];
  const limits = quota.rate_limits as { primary?: unknown; secondary?: unknown } | undefined;
  for (const w of [limits?.primary, limits?.secondary]) {
    const win = limitWindowFrom(w);
    if (win) out.push({ kind: windowKind(win.window_minutes), used_percent: win.used_percent, ...(win.window_minutes !== undefined ? { window_minutes: win.window_minutes } : {}), ...(win.reset_at !== undefined ? { reset_at: win.reset_at } : {}) });
  }
  const scoped = quota.scoped;
  if (Array.isArray(scoped)) for (const s of scoped) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const entry = s as { name?: unknown; used_percent?: unknown; window_minutes?: unknown; reset_at?: unknown };
    const win = limitWindowFrom(entry);
    if (!win || typeof entry.name !== "string" || !entry.name) continue;
    out.push({ kind: "scoped", label: entry.name, used_percent: win.used_percent, ...(win.window_minutes !== undefined ? { window_minutes: win.window_minutes } : {}), ...(win.reset_at !== undefined ? { reset_at: win.reset_at } : {}) });
  }
  return out;
}

/** The Claude Code login's plan windows as one account (the row shows Claude as a single group). */
async function anthropicLimitAccounts(deps: AdminDeps): Promise<LimitsAccount[]> {
  let usage: Record<string, Record<string, unknown>>;
  try {
    usage = (await deps.claudeUsage?.()) ?? {};
  } catch {
    return [];
  }
  const quota = usage.current ?? Object.values(usage)[0];
  if (!quota) return [];
  const windows = claudeLimitWindows(quota);
  if (!windows.length) return [];
  const at = typeof quota.at === "number" ? quota.at : Date.now();
  return [{ account: 0, windows, at }];
}

/** Every ChatGPT account's windows, paused and needs-login accounts left out and unnumbered. */
function chatgptLimitAccounts(accounts: ChatGptAccountStatus[]): LimitsAccount[] {
  const kept = accounts.filter((a) => a.state !== "paused" && a.state !== "needs-login");
  const out: LimitsAccount[] = [];
  kept.forEach((account, index) => {
    const quota = account.quota;
    if (!quota || typeof quota.at !== "number") return;
    const limits = quota.rate_limits as { primary?: unknown; secondary?: unknown } | undefined;
    const windows: LimitsWindow[] = [];
    for (const w of [limits?.primary, limits?.secondary]) {
      const win = limitWindowFrom(w);
      if (win) windows.push({ kind: windowKind(win.window_minutes), used_percent: win.used_percent, ...(win.window_minutes !== undefined ? { window_minutes: win.window_minutes } : {}), ...(win.reset_at !== undefined ? { reset_at: win.reset_at } : {}) });
    }
    if (windows.length) out.push({ account: index, windows, at: quota.at });
  });
  return out;
}

/** Every Antigravity account's windows (Gemini, Argon and selected third-party ones), paused left out. */
async function googleLimitAccounts(deps: AdminDeps, name: string): Promise<LimitsAccount[]> {
  const google = deps.google?.();
  if (!google) return [];
  const statuses = google.accounts()[name] ?? [];
  const groups = (await google.usage?.(name)) ?? {};
  const kept = statuses.filter((a) => a.state !== "paused" && a.state !== "needs-login");
  const at = Date.now();
  // The third-party (Claude and GPT) windows only when this provider has such a model selected:
  // beside Gemini's own they made four figures, two of them a pool nobody here spends (2026-10-20).
  const provider = deps.config().providers[name];
  const models = provider && "models" in provider && Array.isArray(provider.models) ? provider.models : [];
  const thirdParty = models.some((m) => /^(claude-|gpt-oss(-|$))/i.test(typeof m === "string" ? m : m.id));
  const out: LimitsAccount[] = [];
  kept.forEach((account, index) => {
    const quotient = groups[account.id];
    if (!quotient || !quotient.length) return;
    // Scoped is a display kind, not a third-party marker: Argon's own weekly quota is scoped too.
    const windows: LimitsWindow[] = googleWindowsFromGroups(quotient).filter((w) => thirdParty || w.kind !== "scoped" || w.label !== "3P");
    if (windows.length) out.push({ account: index, windows, at });
  });
  return out;
}

/** Every provider whose quota can be read, in one shape, for `GET /api/limits`. */
async function buildLimits(deps: AdminDeps): Promise<{ providers: LimitsProvider[] }> {
  const providers: LimitsProvider[] = [];
  const chatgpt = deps.chatgpt?.();
  const accounts = chatgpt?.accounts?.() ?? {};
  for (const [name, p] of Object.entries(deps.config().providers)) {
    if (p.limits === false) continue;
    if (p.type === "anthropic" && p.auth === "claude-code") {
      const rows = await anthropicLimitAccounts(deps);
      if (rows.length) providers.push({ provider: name, type: "anthropic", title: "Claude", accounts: rows });
    } else if (p.type === "chatgpt") {
      const rows = chatgptLimitAccounts(accounts[name] ?? []);
      if (rows.length) providers.push({ provider: name, type: "chatgpt", title: "GPT", accounts: rows });
    } else if (p.type === "google" && p.auth === "antigravity") {
      const rows = await googleLimitAccounts(deps, name);
      if (rows.length) providers.push({ provider: name, type: "google", title: "Gemini", accounts: rows });
    } else if (p.type === "openai-compatible" && isOpenCodeGo(p)) {
      const credentials = p.credentials?.length ? p.credentials : [undefined];
      const rows = await Promise.all(credentials.map(async (credential, account): Promise<LimitsAccount> => ({
        account,
        ...(credential?.label !== undefined ? { label: credential.label } : {}),
        windows: ((await deps.opencodeUsage?.(name, credential?.id)) ?? []).map((w) => ({ ...w })),
        at: Date.now(),
      })));
      if (rows.some((row) => row.windows.length)) providers.push({ provider: name, type: "opencode-go", title: "Go", accounts: rows });
    } else if (p.type === "grok") {
      const windows = (await deps.grokUsage?.(name)) ?? [];
      if (windows.length) providers.push({ provider: name, type: "grok", title: "Grok", accounts: [{ account: 0, windows: windows.map((w) => ({ ...w })), at: Date.now() }] });
    }
  }
  return { providers };
}

/** One discovered/offered model. Exactly the config shape, so a preset's per-model override
 * (wire/url/authHeader) can be carried straight into a provider entry. */
type ModelEntry = ProviderModel;
type ProbeAuth = "ok" | "bad-key" | "not-entitled" | "unreachable" | "unknown" | "missing";
type ProbeRequest = {
  type: "anthropic-compatible" | "openai-compatible";
  url: string;
  headers?: Record<string, string>;
  modelsUrl?: string;
  modelsAuthHeader?: string;
  /** Model id to use for the auth check when the provider has no listing endpoint (e.g. the preset's first fallback). */
  probeModel?: string;
  /**
   * The catalog preset this provider was built from. `/models` reports ids only, never the wire each
   * one speaks, so the preset's own fallback list is the source for that: discovery fills each
   * matching id with the preset's `wire`/`url`/`authHeader`. Absent, the models come back bare.
   */
  preset?: string;
  /**
   * A header the vendor recognises a conversation by. Not only a cache hint for some of them:
   * OpenCode Go refuses a request without `x-opencode-session` outright, so a connection test that
   * omits it reports a broken provider that is in fact fine.
   */
  sessionHeader?: string;
  /** The OpenAI wire the provider is saved with. Only a hand-entered provider is tested on it; see `probeProvider`. */
  wire?: "chat" | "responses";
};

type ChatgptLogin = { running: boolean; startedAt?: string; finishedAt?: string; ok?: boolean; output?: string };
let chatgptLogin: ChatgptLogin = { running: false };
/** The Claude subscription sign-in in progress (or the last one), for GET /api/claude-oauth. */
let claudeOAuth: ClaudeOAuthSession | null = null;
/** The Google (Antigravity) sign-in in progress (or the last one), for GET /api/google-login. */
let googleOAuth: GoogleOAuthSession | null = null;
/** One routed model's ladder, from the provider that declares it — what the picker's effort menu
 * should offer for it. Undefined when no provider declares the id: the menu is then left alone. */
export function effortLevelsForModel(cfg: Config, modelId: string): string[] | undefined {
  const base = modelId.split("@")[0]!;
  const target = resolve(base, {}, cfg) ?? resolve(cfg.aliases[base] ?? base, {}, cfg);
  if (!target) return undefined;
  const own = effortLevels(cfg).providers[target.provider];
  const id = cfg.providers[target.provider]?.models?.find(m => m.id === target.model || m.id.replace(/-\d{8}$/, "") === target.model.replace(/-\d{8}$/, ""))?.id ?? target.model;
  return own?.models?.[id] ?? own?.default;
}

// Only for when Anthropic's own list cannot be had (no sign-in yet, offline): the live list is
// `deps.claudeModels`, and a release after this table is cut appears there by itself (2026-10-08).
const CLAUDE_MODEL_FALLBACK: { id: string; name: string }[] = [
  { id: "claude-haiku-5-5", name: "Haiku 5.5" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  { id: "claude-opus-5-5", name: "Opus 5.5" },
  { id: "claude-fable-5-1", name: "Fable 5.1" },
  { id: "claude-opus-5", name: "Opus 5" },
  { id: "claude-sonnet-5", name: "Sonnet 5" },
  { id: "claude-fable-5", name: "Fable 5" },
  { id: "claude-opus-4-8", name: "Opus 4.8" },
  { id: "claude-opus-4-7", name: "Opus 4.7" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
  { id: "claude-opus-4-6", name: "Opus 4.6" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5" },
];

/** The account's Claude models, or the table above when Anthropic's list cannot be had. */
async function claudeModelList(deps: AdminDeps): Promise<(ModelEntry & { name: string })[]> {
  const live = await deps.claudeModels?.().catch(() => null);
  return live?.length ? live.map(({ line: _line, createdAt: _createdAt, ...model }) => ({ ...model, name: model.name ?? model.id })) : CLAUDE_MODEL_FALLBACK;
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

/** Newest mtime of the served GUI files; the page reloads itself when this changes (an open window would otherwise run stale JS). */
function uiRevision(): string {
  try {
    const files = ["index.html", "app.js", "style.css", "i18n.js", "presets-fallback.js"];
    return String(Math.max(...files.map((f) => { try { return fs.statSync(path.join(UI_ROOT, f)).mtimeMs; } catch { return 0; } })));
  } catch {
    return "0";
  }
}

/** Newest CLI the Desktop app has cached, from the same per-platform directories sign-in uses. */
function cliVersion(): string {
  let readable = false;
  const versions: string[] = [];
  for (const dir of desktopClaudeCodeDirs()) {
    try {
      versions.push(...fs.readdirSync(dir).filter((d) => /^\d+\.\d+\.\d+$/.test(d)));
      readable = true;
    } catch {
      /* not this platform's layout, or no Desktop app */
    }
  }
  if (!readable) return "n/a";
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.at(-1) ?? "none";
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
  const own = readChatGptAccounts(homeDir()).length > 0;
  const borrowed = fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"));
  return mode === "own" ? own : mode === "borrow-codex" ? borrowed : own || borrowed;
}

/**
 * Whether the Grok CLI's session is there and not yet expired. A session near its end still counts:
 * the router asks the CLI to refresh it before the next turn.
 */
export function grokSignedIn(p: { home?: string }): boolean {
  const token = readGrokToken(grokAuthPath(p.home ?? grokHome()));
  return token !== null && (token.expiresAt === 0 || token.expiresAt > Date.now());
}

/**
 * An Antigravity provider is only as usable as its accounts: none signed in, or every one waiting on
 * Google's verification page, answers nothing however reachable the host is.
 */
export function googleHealth(accounts: GoogleAccountStatus[]): { needsLogin: boolean; needsVerification?: true } {
  if (accounts.every((a) => a.state === "needs-login")) return { needsLogin: true };
  const inRotation = accounts.filter((a) => a.state !== "paused" && a.state !== "needs-login");
  return inRotation.length > 0 && inRotation.every((a) => a.state === "needs-verification") ? { needsLogin: false, needsVerification: true } : { needsLogin: false };
}

type ChatgptStatus = {
  quota: Record<string, Record<string, unknown> | null>;
  auth: Record<string, string>;
  signedIn: Record<string, boolean>;
  accounts: Record<string, ChatGptAccountStatus[]>;
  stale?: true;
  staleReason?: Record<string, string>;
};

/** Shared by status and mod options: refresh old quota, then read per-account rotation state. */
async function chatgptStatus(deps: AdminDeps, opts: { refresh?: boolean } = {}): Promise<ChatgptStatus> {
  const chatgpt = deps.chatgpt?.() ?? { quota: {}, auth: {} };
  const staleReasons: Record<string, string> = {};
  const now = Date.now();
  for (const [name, q] of Object.entries(chatgpt.quota)) {
    if (!chatgpt.refresh) break;
    const at = q && typeof q.at === "number" ? q.at : 0;
    if (!opts.refresh && at && now - at < 10 * 60 * 1000) continue;
    const fresh = await chatgpt.refresh(name);
    if (fresh) chatgpt.quota[name] = fresh;
    else staleReasons[name] = opts.refresh ? "refresh requested but lookup failed" : "lookup failed; showing last known value";
  }
  const signedIn: Record<string, boolean> = {};
  for (const [name, p] of Object.entries(deps.config().providers)) {
    if (p.type === "chatgpt") signedIn[name] = chatgptSignedIn(p.auth);
  }
  return {
    quota: chatgpt.quota, auth: chatgpt.auth, signedIn, accounts: chatgpt.accounts?.() ?? {},
    ...(Object.keys(staleReasons).length ? { stale: true, staleReason: staleReasons } : {}),
  };
}

export type ModOptions = {
  /** Each worker with its model's effort ladder (mod efforts only) and how it is paid for. */
  agents: (ReturnType<typeof generatedAgents>[number] & { efforts: Effort[]; billing: Billing })[];
  models: { model: string; provider: string; name: string; judgeOnly: boolean }[];
  providers: { name: string; type: Provider["type"]; usable: boolean; billing: Billing; reason?: string; exhaustedAt?: number; exhaustedUntil?: number; models?: Record<string, ModelUnavailable> }[];
  zen: { configured: boolean; model: string | null };
  scores: ReturnType<typeof buildModelScores>;
  /** Claude's own models' effort ladder, for the rungs that run Claude Code's own agent. */
  claudeEfforts: Effort[];
};

/** One model out while its provider still answers others: a spent quota group, until it resets. */
export type ModelUnavailable = { reason: string; exhaustedAt?: number; exhaustedUntil?: number };

/**
 * An Antigravity provider's spent quota groups: a group resting on every account that is otherwise
 * in rotation (`quotaCooldowns`, set only by a 429 that proves the group spent). Google counts Gemini
 * and Claude/GPT models separately, and each host its own, so a spent group takes only its own models
 * on that host out of the ladder. The accounts are the one source, so clearing an account's cooldown
 * or signing in a fresh one puts the models back at once.
 *
 * An account that is only cooling still counts: it takes the group's turns again once both its own
 * rest and the group's are over, so the group is back at the soonest of those per-account waits.
 */
function antigravityGroupsOut(accounts: readonly GoogleAccountStatus[], now: number): Record<string, ModelUnavailable> {
  const out: Record<string, ModelUnavailable> = {};
  const inRotation = accounts.filter(a => a.state === "ready" || a.state === "cooling");
  for (const scope of new Set(inRotation.flatMap(a => Object.keys(a.quotaCooldowns ?? {})))) {
    const waits = inRotation.map(a => Math.max(a.state === "cooling" ? a.cooldownSeconds ?? 0 : 0, a.quotaCooldowns?.[scope] ?? 0));
    if (waits.some(seconds => seconds <= 0)) continue;
    out[scope] = { reason: "quota_exhausted", exhaustedUntil: now + Math.min(...waits) * 1000 };
  }
  return out;
}

const MOD_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const modEfforts = (levels: readonly string[] | undefined): Effort[] => (levels ?? []).filter((level): level is Effort => MOD_EFFORTS.includes(level));

/**
 * An OpenCode Go subscription's spent windows, from the same `/usage` read `/api/limits` shows.
 * One key is out once any of its windows (five-hour, weekly, monthly) reads 100%, because the plan
 * refuses every model on that key; it is back when the latest of its full windows resets. The
 * provider leaves the ladder only while every key is out, as rotation would otherwise find one to
 * use (#95). No reader, a failed read or an empty answer is not evidence: the answer stays today's.
 */
async function opencodeGoOut(
  deps: AdminDeps,
  name: string,
  credentials: readonly ProviderCredential[] | undefined,
  now: number,
): Promise<{ reason: "quota_exhausted"; until: number } | undefined> {
  const read = deps.opencodeUsage;
  if (!read) return undefined;
  const keys = credentials?.length ? credentials : [undefined];
  const backs: number[] = [];
  for (const credential of keys) {
    let windows: OpenCodeWindow[];
    try {
      windows = await read(name, credential?.id);
    } catch {
      return undefined;
    }
    if (!windows.length) return undefined;
    const full = windows.filter((w) => w.used_percent >= 100);
    if (!full.length) return undefined;
    // Every window must have room again, so the latest full one is when this key returns. The
    // subscription's own reset is the honest answer; without one, the runtime default applies.
    backs.push(Math.max(...full.map((w) => (w.reset_at !== undefined ? w.reset_at * 1000 : now + 30 * 60_000))));
  }
  const until = Math.min(...backs);
  return until > now ? { reason: "quota_exhausted", until } : undefined;
}

async function modOptions(deps: AdminDeps, scores: ModelScoreCatalog): Promise<ModOptions> {
  const cfg = deps.config();
  const chatgpt = await chatgptStatus(deps);
  const google = deps.google?.().accounts() ?? {};
  const credentials = deps.credentials?.() ?? {};
  const health = deps.providerHealth?.() ?? {};
  const catalog = effortLevels(cfg).providers;
  const agents = generatedAgents(cfg, deps.agentDir, undefined, deps.log).map(a => ({
    ...a,
    efforts: modEfforts(catalog[a.provider]?.models?.[a.model] ?? catalog[a.provider]?.default),
    billing: billingOf(cfg.providers[a.provider] as { type: string; auth?: string; preset?: string; url?: string }, a.model),
  }));
  const now = Date.now();
  const providers = await Promise.all(Object.entries(cfg.providers).map(async ([name, p]) => {
    let usable = true;
    // A spent OpenCode Go window, which the picker must skip before it hands out the work (#95).
    let usageOut: { reason: "quota_exhausted"; until: number } | undefined;
    if (p.type === "chatgpt") {
      const accounts = chatgpt.accounts[name];
      usable = accounts ? accounts.some(a => a.state === "ready" && !exhaustedForMs(a.quota))
        : chatgpt.signedIn[name] === true && !exhaustedForMs(chatgpt.quota[name]);
    } else if (p.type === "google") {
      usable = p.auth === "antigravity" ? (google[name] ?? []).some(a => a.state === "ready")
        : !!(p.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    } else if (p.type === "anthropic") {
      // Stored accounts serve the turn when Claude Code's own login is not seen; the pool refreshes a
      // due token before each turn, so only an account that must sign in again is out.
      usable = p.auth === "api-key" ? !!(p.apiKey || process.env.ANTHROPIC_API_KEY)
        : claudeAuthStore(deps).describeSource() !== null || listClaudeAccounts(homeDir()).some(a => !a.needsReauth);
    } else if (p.type === "openai-compatible" && isOpenCodeGo(p)) {
      usageOut = await opencodeGoOut(deps, name, p.credentials, now);
      if (usageOut) usable = false;
    }
    if (credentials[name]) usable = usable && credentials[name]!.some(c => c.state === "ready" && !c.paused);
    const exhausted = health[name];
    // A runtime exhaustion mark and a spent subscription window can both be true; the later reset
    // is the one the ladder has to wait for.
    let out: { reason: string; exhaustedAt?: number; exhaustedUntil: number } | undefined;
    if (exhausted) out = { reason: exhausted.reason, exhaustedAt: exhausted.at, exhaustedUntil: exhausted.until };
    if (usageOut && (!out || usageOut.until > out.exhaustedUntil)) out = { reason: usageOut.reason, exhaustedUntil: usageOut.until };
    const modelsOut: Record<string, ModelUnavailable> = Object.fromEntries(
      Object.entries(deps.modelHealth?.()[name] ?? {}).map(([model, state]) => [model, { reason: state.reason, exhaustedAt: state.at }]),
    );
    if (p.type === "google" && p.auth === "antigravity") {
      const groups = antigravityGroupsOut(google[name] ?? [], now);
      const scopeOf = deps.google?.().quotaScope;
      const ids = new Set([...(p.models ?? []).map(m => m.id), ...agents.filter(a => a.provider === name).map(a => a.model)]);
      for (const id of ids) {
        const scope = scopeOf?.(name, id);
        if (scope && groups[scope] && !modelsOut[id]) modelsOut[id] = groups[scope];
      }
    }
    return { name, type: p.type, usable: usable && !out, billing: billingOf(p as { type: string; auth?: string; preset?: string; url?: string }),
      ...(out ? { reason: out.reason, ...(out.exhaustedAt !== undefined ? { exhaustedAt: out.exhaustedAt } : {}), exhaustedUntil: out.exhaustedUntil } : {}),
      ...(Object.keys(modelsOut).length ? { models: modelsOut } : {}),
    };
  }));
  const models = Object.entries(cfg.providers).flatMap(([provider, p]) => (p.models ?? []).map(m => ({ model: declaredBy(m.id, cfg).length > 1 ? `${provider}:${m.id}` : m.id, provider, name: m.name ?? m.id, judgeOnly: isJudgeOnlyModel(m.id) })));
  const zen = Object.values(cfg.providers).find(p => {
    if (!p.models?.some(m => isJudgeOnlyModel(m.id))) return false;
    if ("preset" in p && p.preset === "opencode-zen") return true;
    if (!("url" in p) || !p.url) return false;
    const url = new URL(p.url);
    return url.hostname === "opencode.ai" && /^\/zen\/v1(?:\/|$)/.test(url.pathname);
  });
  const model = zen?.models?.find(m => isJudgeOnlyModel(m.id))?.id ?? null;
  const scored = buildModelScores(cfg, await scores.get());
  const claudeEfforts = modEfforts(catalog.anthropic?.default);
  return { agents, models, providers, zen: { configured: model !== null, model }, scores: scored, claudeEfforts };
}

/**
 * What the four workers can be filled from: the generated workers whose provider can run now, with
 * their ladders, billing and cheapest measured cost, then Claude's own models (always there).
 */
function ladderChoices(options: ModOptions): LadderChoice[] {
  const usable = new Set(options.providers.filter(p => p.usable).map(p => p.name));
  const modelOut = (a: { provider: string; model: string }): boolean => !!options.providers.find(p => p.name === a.provider)?.models?.[a.model];
  return [
    ...options.agents.filter(a => usable.has(a.provider) && !modelOut(a)).map(a => {
      const costs = (options.scores.models.find(m => m.model === a.model && m.provider === a.provider)?.variants ?? []).flatMap(v => typeof v.costPerTask === "number" ? [v.costPerTask] : []);
      return { target: { agent: a.name }, model: a.model, provider: a.provider, billing: a.billing, efforts: a.efforts, ...(costs.length ? { cost: Math.min(...costs) } : {}) };
    }),
    ...claudeChoices(options.claudeEfforts),
  ];
}

/**
 * Worker names saved by the build that sanitised a model id without lower-casing it first (#111):
 * the ladder, the allow-list and the fallback name workers by their generated name, so a renamed
 * worker would read as missing and its rung skipped. Migrated wherever settings are read or written,
 * so a ladder the user saved keeps the worker it named; the next save stores the new name.
 */
function migrateWorkerNames(settings: Settings, renames: Record<string, string>): Settings {
  if (Object.keys(renames).length === 0) return settings;
  const agent = (name: string): string => renames[name] ?? name;
  const steps = (list: Step[] | undefined): Step[] | undefined =>
    list?.map(step => ({ ...step, target: { ...step.target, agent: agent(step.target.agent) } }));
  const rungs = (saved: Rungs): Rungs =>
    Object.fromEntries(Object.entries(saved).map(([rung, list]) => [rung, steps(list)])) as Rungs;
  const domains = (rules: DomainRules): DomainRules =>
    Object.fromEntries(Object.entries(rules).map(([domain, rule]) => [domain, { mode: "ladder", rungs: rungs(rule.rungs) }])) as DomainRules;
  const names = (list: string[]): string[] => [...new Set(list.map(agent))];
  const modes = settings.modes.map(mode => ({
    ...mode,
    rungs: rungs(mode.rungs),
    ...(mode.domainRules ? { domainRules: domains(mode.domainRules) } : {}),
  }));
  return {
    ...settings,
    rules: { general: { mode: "ladder", rungs: rungs(settings.rules.general.rungs) } },
    ...(settings.domainRules ? { domainRules: domains(settings.domainRules) } : {}),
    modes,
    allow: names(settings.allow),
    allowKnown: names(settings.allowKnown),
    fallback: { ...settings.fallback, agent: agent(settings.fallback.agent) },
  };
}

/**
 * Fill empty ordered lists in Base and saved modes from the same ticked, connected choices.
 * Existing lists survive availability and allow-list changes; dispatch handles skips.
 */
async function withFilledLadder(deps: AdminDeps, scores: ModelScoreCatalog, settings: Settings): Promise<Settings> {
  settings = migrateWorkerNames(settings, agentRenames(deps.config(), deps.agentDir, deps.log));
  const general = settings.rules.general;
  const sets = [settings, ...settings.modes];
  const domains = sets.flatMap(set => Object.values(set.domainRules ?? {}));
  if (![general, ...settings.modes, ...domains].some(set => ladderNeedsFill(set.rungs))) return settings;
  try {
    const choices = ladderChoices(await modOptions(deps, scores));
    const fill = (rungs: Settings['rules']['general']['rungs']) => fillLadder(rungs, settings.allow, choices, settings.allowKnown).rungs;
    // A domain ladder has two levels: the fold keeps each pair equal, before and after the fill.
    const fillDomains = (rules: DomainRules): DomainRules => Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, { mode: "ladder", rungs: twoLevelRungs(fill(twoLevelRungs(rule.rungs))) }]));
    const modes = settings.modes.map(mode => ({ ...mode, rungs: fill(mode.rungs), ...(mode.domainRules ? { domainRules: fillDomains(mode.domainRules) } : {}) }));
    return { ...settings, rules: { general: { mode: "ladder", rungs: fill(general.rungs) } }, ...(settings.domainRules ? { domainRules: fillDomains(settings.domainRules) } : {}), modes };
  } catch (error) {
    deps.log.warn(`admin: filling the worker ladder failed: ${(error as Error).message}`);
    return settings;
  }
}

async function buildStatus(deps: AdminDeps, opts: { refresh?: boolean } = {}): Promise<Record<string, unknown>> {
  const cfg = deps.config();
  const health = deps.providerHealth?.() ?? {};
  const providers: Record<string, { url: string; type: string; reachable: boolean; authSource?: "observed" | "env" | "keychain" | "credentials-file" | "token-file" | null; signedIn?: "oauth" | "setup-token" | null; accountCount?: number }> = {};
  // Keyed in the order the config lists them. Assigning inside the Promise.all callbacks ordered
  // them by whichever TCP check answered first, so the Health list reshuffled on every poll.
  const checked = await Promise.all(
    Object.entries(cfg.providers).map(async ([name, p]) => {
      const url = p.type === "anthropic" ? "https://api.anthropic.com" : p.type === "chatgpt" ? (p.url ?? "https://chatgpt.com/backend-api") : p.type === "google" ? (p.url ?? "https://generativelanguage.googleapis.com") : p.type === "grok" ? (p.url ?? GROK_DEFAULT_URL) : p.url;
      let reachable = false;
      try {
        const u = new URL(url);
        reachable = await tcpReachable(u.hostname, Number(u.port) || (u.protocol === "https:" ? 443 : 80));
      } catch {
        reachable = false;
      }
      return [name, {
        url,
        type: p.type,
        reachable,
        usable: reachable && !health[name],
        ...(health[name] ? { exhaustion: health[name] } : {}),
        ...(deps.modelHealth ? { models: Object.fromEntries(Object.entries(deps.modelHealth()[name] ?? {}).map(([model, state]) => [model, { usable: false, ...state }])) } : {}),
        // Whether the router could run a `WebSearch` side request through this provider, so the
        // Clients screen can say so beside a model name. Nothing on that screen said which ones
        // those are, and a `smallFast` slot pointed at one turns every search into a visible failure
        // (2026-09-21: it was set to OpenCode Go's DeepSeek, which accepts the search request and
        // answers with a fabricated one).
        //
        // It answers "can the router search here", not "can this model search". Those differ:
        // measured 2026-09-21, OpenCode Go's Responses endpoint runs OpenAI's hosted `web_search`
        // and cites real pages, but the wire is OpenAI-shaped while its hits come back as Responses
        // events — a backend the router does not have, so a search still cannot go through it.
        // Naming the provider's own capability instead would be a promise the router cannot keep.
        ...(answersWebSearch(cfg, name) ? { webSearch: true } : {}),
        // A provider whose plan searches on another endpoint does so for some models only.
        ...(() => {
          const models = (("models" in p && p.models) || []).map((m) => typeof m === "string" ? m : m.id).filter((id) => searchProviderFor(p, id));
          return models.length ? { webSearchModels: models } : {};
        })(),
        // Reaching the host says nothing about being able to use it: a chatgpt provider with no
        // credentials is not "connected", and calling it that sends the user off believing it works.
        ...(p.type === "chatgpt" ? { needsLogin: !chatgptSignedIn(p.auth) } : {}),
        ...(p.type === "grok" ? { needsLogin: !grokSignedIn(p) } : {}),
        ...(p.type === "google" && p.auth === "antigravity" ? googleHealth(deps.google?.().accounts?.()[name] ?? []) : {}),
        ...(p.type === "anthropic"
          ? {
              authSource: p.auth === "claude-code" ? claudeAuthStore(deps).describeSource() : null,
              signedIn: p.auth === "claude-code" ? (listClaudeAccounts(homeDir()).length > 0 ? "oauth" : readClaudeAuthFile(homeDir())?.source ?? null) : null,
              accountCount: p.auth === "claude-code" ? listClaudeAccounts(homeDir()).length : 0,
            }
          : {}),
      }] as const;
    }),
  );
  for (const [name, entry] of checked) providers[name] = entry;
  const chatgpt = await chatgptStatus(deps, opts);
  const env = readSettingsEnv();
  const wantProxy = `http://127.0.0.1:${cfg.listen.port}`;
  const picker = deps.picker?.() ?? { enabled: false, hosts: [], last: null };
  // Readiness is not liveness: this process answering says nothing about whether a Claude request
  // can go through. In picker mode a missing certificate trust or app proxy entry looks, from the
  // app, exactly like a dead router. Each problem is a code the tray and the GUI can name.
  const problems: string[] = [];
  // A config that failed validation is not a healthy router: the routes it names may be missing,
  // and the file has to be fixed before anything else can be trusted (G-D14).
  const configErrors = deps.configErrors?.() ?? [];
  if (configErrors.length) problems.push("config");
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
    autoUpdate: deps.autoUpdater?.status() ?? { enabled: cfg.autoUpdate !== false, running: false },
    processPriority: deps.processPriority?.() ?? processPriorityState(cfg.processPriority),
    readiness: { ready: problems.length === 0, problems },
    // The errors themselves, so a reader can name the line to fix rather than only "config".
    config: { errors: configErrors },
    // Outbound provider calls run on undici's own dispatcher, never the environment's proxy
    // variables, so a network that requires a proxy is bypassed silently. Names only: a proxy URL
    // can carry a credential (G-D11). The dashboard says so; readiness is unaffected, since a
    // proxy that is set but not needed is not a fault.
    envProxy: { set: ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"].filter((name) => (process.env[name] ?? "") !== "") },
    // Which files this process is running, so the app can tell an old router from its own after
    // an update: a zip unpacked next to the previous install left the old one serving (2026-09-15).
    runtime: { node: process.execPath, router: process.argv[1] ?? null, startedAt: STARTED_AT },
    home: homeDir(),
    // The identity captured when this process started: a caller accepts this status as its own only
    // when both the installation id and the pid match what it would act on. A file changed while
    // this process runs does not rewrite what it is.
    installId: deps.instance?.installId ?? null,
    pid: deps.instance?.pid ?? null,
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
    // `quota` stays one snapshot per provider (the account in use) for the readers that want one
    // number; `accounts` is the per-account view, read after the refresh above so it is as fresh.
    chatgpt,
    ...(deps.claudeUsage && hasClaudeSubscription(cfg) ? { claude: { accounts: await claudeAccountUsage(deps) } } : {}),
    // Only present for providers that declare a pool; a provider with one credential has nothing
    // to report and would only add a row that never changes.
    credentials: deps.credentials?.() ?? {},
    picker,
    statusMod: statusModEnabled(),
    pickerModels: chatPickerModels(cfg).map((m) => m.name || m.model),
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
    value = { caTrusted: caTrusted(certPaths(homeDir()).caPem), appProxy: currentAppProxy().ours };
  } catch {
    // Unknown counts as not ready; the next poll tries again.
  }
  pickerTrustMemo = { at: now, value };
  return value;
}

/**
 * Write `cli.models` into `~/.claude/settings.json` right after a GUI save, so a slot chosen on the
 * Clients screen takes effect in the next session instead of waiting for an `install`.
 *
 * Returns a human-readable warning when the write could not happen, or null. A slot that silently
 * does nothing is the exact bug this closes, so a failure has to come back to the screen rather
 * than being swallowed into the router log.
 */
function syncModelSlotsForGui(cfg: Config, agentDir?: string): string | null {
  try {
    const home = homeDir();
    syncModelSlots({
      proxyUrl: `http://127.0.0.1:${cfg.listen.port}`,
      caPath: certPaths(home).caPem,
      force: false,
      // Always an object, never omitted: `cli.models` absent means every slot should be back on
      // Claude, and `syncModelSlots` reads an absent `models` as "do not touch these".
      models: cfg.cli.models ?? {},
    });
    syncContextWindows(cfg, agentDir ? [agentDir] : undefined);
    return null;
  } catch (e) {
    const message = (e as Error).message;
    if (/not ours/.test(message)) return "settings.json has another proxy's HTTPS_PROXY; the model slots were not written. Run `clauderipple install --force` to take it over.";
    return `model slots were not written to settings.json: ${message}`;
  }
}

/**
 * The body of `POST /api/image`, checked: `{prompt, aspect?, format?, background?, images?}`,
 * `images` being `data:image/...;base64,` URLs. A string is the reason it was refused.
 */
export function parseImageRequest(raw: unknown): ImageRequest | string {
  if (!raw || typeof raw !== "object") return "expected a JSON object";
  const body = raw as Record<string, unknown>;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "prompt is required";
  const out: ImageRequest = { prompt: body.prompt };
  const pick = <T extends string>(key: "aspect" | "format" | "background", allowed: readonly T[]): string | null => {
    const value = body[key];
    if (value === undefined) return null;
    if (typeof value !== "string" || !allowed.includes(value as T)) return `${key} must be one of ${allowed.join(", ")}`;
    (out as Record<string, unknown>)[key] = value;
    return null;
  };
  const refused = pick("aspect", IMAGE_ASPECTS) ?? pick("format", IMAGE_FORMATS) ?? pick("background", IMAGE_BACKGROUNDS);
  if (refused) return refused;
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) return "images must be a list of data: URLs";
    const images: { mediaType: string; data: string }[] = [];
    for (const url of body.images) {
      const m = typeof url === "string" ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url) : null;
      if (!m) return "each image must be a data:image/...;base64, URL";
      images.push({ mediaType: m[1]!.toLowerCase(), data: m[2]!.replace(/\s/g, "") });
    }
    if (images.length) out.images = images;
  }
  return out;
}

function readBody(req: http.IncomingMessage, limit = MAX_BODY, overflowError?: Error): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        chunks.length = 0;
        reject(overflowError ?? new Error("body too large"));
        if (!overflowError) req.destroy(); // mod saves must receive their 413, not a reset
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

/** Write the config file atomically under its lock. The one save path: the GUI's PUT, the
 * capability measurements and the CLI's picker toggle all go through it or take the same lock, so
 * the router never picks up a half-written file and two writers never replace it mid-change. */
function writeConfigFile(configFile: string, config: Config): void {
  withFileLock(configFile, () => writeConfigFileLocked(configFile, config));
}

function writeConfigFileLocked(configFile: string, config: Config): void {
  const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, configFile);
}

/** The disk fingerprint also detects CLI edits and background measurements, without persisting API metadata. */
function configSnapshot(deps: AdminDeps): { config: Config; configRevision: string } {
  let text: string;
  try { text = fs.readFileSync(deps.configFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = JSON.stringify(deps.config());
  }
  return { config: JSON.parse(text) as Config, configRevision: crypto.createHash("sha256").update(text).digest("hex") };
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
  return new ClaudeCodeAuthStore(undefined, {
    home: homeDir(),
    ...(deps.observedClaudeCodeAuth ? { observed: deps.observedClaudeCodeAuth } : {}),
    ...(deps.claudeCodeCredentialReaders ? { credentialReaders: deps.claudeCodeCredentialReaders } : {}),
  });
}

async function probeAnthropicApiKey(apiKey: string, probeFetch: (url: string, init: RequestInit) => Promise<Response> = fetchWithTimeout): Promise<{ ok: boolean; auth: ProbeAuth; models: ModelEntry[]; error?: string }> {
  // The key's own model list where it answers; a key that cannot list is still tested below.
  const listed = await fetchClaudeModels("https://api.anthropic.com", { "x-api-key": apiKey }, probeFetch).catch(() => []);
  const models: ModelEntry[] = listed.length ? listed.map(({ line: _line, createdAt: _createdAt, ...model }) => model) : CLAUDE_MODEL_FALLBACK;
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
    if (refusedForModel(response.status, detail)) return { ok: true, auth: "ok", models };
    if (response.status === 402 || /insufficient|balance|credit|quota|billing/i.test(detail)) return { ok: true, auth: "ok", models, error: `no-credits: ${response.status} ${detail}` };
    return { ok: false, auth: response.status >= 500 ? "unreachable" : "unknown", models, error: `${label} returned ${response.status}: ${detail}` };
  } catch (e) {
    return { ok: false, auth: "unreachable", models, error: `${label}: ${errorText(e)}` };
  }
}

async function probeClaudeCodeAuth(deps: AdminDeps): Promise<{ ok: boolean; auth: "ok" | "missing"; source: "observed" | "env" | "keychain" | "credentials-file" | "token-file" | null; signedIn: "oauth" | "setup-token" | null; accountCount: number; models: ModelEntry[] }> {
  const source = claudeAuthStore(deps).describeSource();
  // Our own accounts are reported separately: a Claude Desktop session can outrank them, and without
  // this the screen would answer a finished sign-in with the source it was already showing.
  const accounts = listClaudeAccounts(homeDir());
  const hasUsableAccount = accounts.some((account) => !account.needsReauth && account.expiresAt > Date.now());
  const signedIn = accounts.length > 0 ? "oauth" : readClaudeAuthFile(homeDir())?.source ?? null;
  return { ok: source !== null || hasUsableAccount, auth: source !== null || hasUsableAccount ? "ok" : "missing", source, signedIn, accountCount: accounts.length, models: await claudeModelList(deps) };
}

/** The reasoning levels a `GET /v1beta/models` entry says the model takes, or none to offer. */
function googleEffortLevels(entry: { thinking?: unknown; id?: unknown }): string[] {
  // `thinking: true` is the listing's own flag that a model reasons. The Generative Language API
  // documents no per-model effort ladder, so a thinking model is offered the Gemini-3 levels this
  // router maps onto (translate.ts): a model that only knows a subset clamps server-side.
  return entry.thinking === true ? ["minimal", "low", "medium", "high"] : [];
}

/**
 * `GET {base}/v1beta/models` with the key on `x-goog-api-key`, following `nextPageToken`.
 *
 * The auth check is the listing itself: Google answers a bad key with `400 API_KEY_INVALID` (or a
 * 401/403), so there is no separate one-token request to make.
 */
async function probeGoogle(body: { apiKey?: unknown; url?: unknown }, probeFetch: (url: string, init: RequestInit) => Promise<Response> = fetchWithTimeout): Promise<{ ok: boolean; auth: ProbeAuth; models: ModelEntry[]; error?: string }> {
  const apiKey = typeof body.apiKey === "string" && body.apiKey.length > 0 ? body.apiKey : (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
  if (!apiKey) return { ok: false, auth: "missing", models: [], error: "no API key; set one or GEMINI_API_KEY" };
  const base = (typeof body.url === "string" && body.url ? body.url : "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const models: ModelEntry[] = [];
  let pageToken: string | undefined;
  try {
    // Bounded: a catalogue that keeps handing back a token must not spin the admin request forever.
    for (let page = 0; page < 20; page++) {
      const url = `${base}/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const response = await probeFetch(url, { headers: { "x-goog-api-key": apiKey } });
      if (response.status === 401 || response.status === 403) return { ok: false, auth: "bad-key", models: [], error: `models endpoint returned ${response.status}` };
      if (!response.ok) {
        const detail = snippet(await response.text());
        // A wrong key comes back 400 with `status: API_KEY_INVALID`; that is a bad key, not a bad base.
        const badKey = /API_KEY_INVALID|API key not valid|invalid api key/i.test(detail);
        return { ok: false, auth: badKey ? "bad-key" : response.status >= 500 ? "unreachable" : "unknown", models: [], error: `models endpoint returned ${response.status}: ${detail}` };
      }
      const parsed = await response.json() as { models?: unknown; nextPageToken?: unknown };
      for (const raw of Array.isArray(parsed.models) ? parsed.models : []) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; supportedGenerationMethods?: unknown; thinking?: unknown };
        if (typeof entry.name !== "string") continue;
        const id = entry.name.replace(/^models\//, "");
        // Only models that can actually answer `generateContent` are worth listing; embedding and
        // prediction models share the catalogue but cannot serve a turn.
        const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
        if (!methods.some((method) => method === "generateContent")) continue;
        const levels = googleEffortLevels(entry);
        models.push({
          id,
          ...(typeof entry.displayName === "string" ? { name: entry.displayName } : {}),
          ...(typeof entry.inputTokenLimit === "number" && entry.inputTokenLimit > 0 ? { contextWindow: Math.floor(entry.inputTokenLimit) } : {}),
          ...(levels.length > 0 ? { effortLevels: levels } : {}),
        });
      }
      pageToken = typeof parsed.nextPageToken === "string" && parsed.nextPageToken ? parsed.nextPageToken : undefined;
      if (!pageToken) break;
    }
    if (models.length === 0) return { ok: true, auth: "ok", models, error: "no generateContent models listed" };
    return { ok: true, auth: "ok", models };
  } catch (e) {
    return { ok: false, auth: "unreachable", models, error: `models endpoint: ${errorText(e)}` };
  }
}

/**
 * `{type:"google", auth:"antigravity"}`: whether any Google account is signed in, and the model list
 * Cloud Code Assist returns for it (falling back to the static list). No network call is made here
 * beyond the catalogue the provider already serves; a signed-out state is the common answer.
 */
async function probeGoogleAntigravity(deps: AdminDeps): Promise<{ ok: boolean; auth: ProbeAuth; models: ModelEntry[]; error?: string }> {
  const accounts = deps.google?.().accounts?.() ?? {};
  const signedIn = Object.values(accounts).some((list) => list.length > 0) || readGoogleAccounts(homeDir()).length > 0;
  if (!signedIn) return { ok: false, auth: "missing", models: staticAntigravityModels(), error: "no Google account; run `clauderipple google-login`" };
  const named = Object.keys(accounts)[0];
  const models = named ? await deps.google?.().models?.(named).catch(() => null) ?? null : null;
  return { ok: true, auth: "ok", models: models ?? staticAntigravityModels() };
}

type GrokProbeResult = { ok: boolean; auth: ProbeAuth; models: ModelEntry[]; modelsSource: "catalog" | "fallback"; warning: string; error?: string };

/**
 * `{type:"grok"}`: whether the Grok CLI's session is usable, and the models its chat proxy lists.
 * The session goes through the same `GrokAuth` the adapter uses — one near its end is refreshed
 * through the CLI here too — and the listing is asked with the headers live traffic sends, since a
 * test that presents another auth set certifies a path nobody uses (§5).
 */
async function probeGrok(
  body: { home?: unknown; cli?: unknown; url?: unknown; clientVersion?: unknown },
  log: Logger,
  probeFetch: (url: string, init: RequestInit) => Promise<Response> = fetchWithTimeout,
): Promise<GrokProbeResult> {
  const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
  const home = text(body.home) ?? grokHome();
  const cli = text(body.cli);
  const clientVersion = text(body.clientVersion);
  const fallback = (result: Omit<GrokProbeResult, "models" | "modelsSource" | "warning">): GrokProbeResult =>
    ({ ...result, models: GROK_FALLBACK_MODELS, modelsSource: "fallback", warning: GROK_WARNING });
  const versionProblem = clientVersion ? headerValueProblem(clientVersion) : null;
  if (versionProblem) return fallback({ ok: false, auth: "unknown", error: `clientVersion cannot be sent as a header: ${versionProblem}` });
  // The adapter's own instance for this session, so a probe joins a refresh a turn started (and the
  // reverse) instead of spawning a second CLI.
  const auth = sharedGrokAuth({ home, ...(cli ? { cli } : {}), log });
  let token;
  try {
    token = await auth.token();
  } catch (error) {
    return fallback({ ok: false, auth: "missing", error: errorText(error) });
  }
  const base = (text(body.url) ?? GROK_DEFAULT_URL).replace(/\/+$/, "");
  const { "x-grok-model-override": _route, ...headers } = grokHeaders(token.key, "", await auth.clientVersion(clientVersion));
  let response: Response;
  try {
    response = await probeFetch(`${base}/models`, { headers });
  } catch (error) {
    // fetch quotes a header value it refuses, which here is the session token.
    return fallback({ ok: false, auth: "unreachable", error: redactErrorText(errorText(error), [token.key]) });
  }
  if (response.status === 401 || response.status === 403) {
    return fallback({ ok: false, auth: "bad-key", error: `the proxy refused the Grok session (HTTP ${response.status}): ${GROK_AUTH_HINT}` });
  }
  if (!response.ok) {
    const detail = redactErrorText(await response.text().catch(() => ""), [token.key]);
    return fallback({ ok: false, auth: "unknown", error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}` });
  }
  const models = grokModelsFromListing(await response.json().catch(() => null));
  return models.length
    ? { ok: true, auth: "ok", models, modelsSource: "catalog", warning: GROK_WARNING }
    : fallback({ ok: true, auth: "ok" });
}

function chatCompletionsUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/chat/completions`;
}

function responsesUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/responses`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsedModels(value: unknown): ModelEntry[] {
  const data = value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data) ? (value as { data: unknown[] }).data : [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as { id?: unknown; name?: unknown; supported_parameters?: unknown; context_length?: unknown };
    if (typeof r.id !== "string") return [];
    const supported = Array.isArray(r.supported_parameters) && r.supported_parameters.every((value) => typeof value === "string")
      ? r.supported_parameters as string[]
      : undefined;
    // OpenRouter and several other OpenAI-compatible vendors report each model's real context
    // window here. Taking it means a routed model gets its own window without anyone typing it.
    const contextWindow = typeof r.context_length === "number" && Number.isFinite(r.context_length) && r.context_length > 0
      ? Math.floor(r.context_length)
      : undefined;
    return [{
      id: r.id,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      ...(supported ? { effortLevels: supported.includes("reasoning_effort") ? ["low", "medium", "high"] : [] } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    }];
  });
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Whether a refused test request was refused for its model alone, which still shows the endpoint is
 * right and the key was accepted. Anthropic's own wire says so with 404 not_found_error rather than
 * 400 — abliteration.ai answers "Requested model was not found." (issue #42) — so 404 counts too,
 * but only with a model named in the body: a bare 404 is a wrong URL.
 */
function refusedForModel(status: number, detail: string): boolean {
  return (status === 400 || status === 404) && /model.{0,80}(not.?found|invalid|unsupported|does not exist)|unknown.{0,20}model/i.test(detail);
}

/**
 * Fill each discovered model with the wire, endpoint and auth convention its preset declares for it.
 *
 * `/models` reports ids alone, and one plan can serve several wires on one catalog (OpenCode Go's
 * Responses, Chat and Anthropic groups). A discovered model left bare would be routed on the
 * provider's default wire — the wrong shape on the wrong path for two of the three groups. The
 * preset's fallback list is the only place that mapping is written down, so it is read here; an id
 * not on it stays bare and gets the provider's own wire.
 */
function withPresetOverrides(models: ModelEntry[], presetId: string | undefined): ModelEntry[] {
  if (!presetId) return models;
  const preset = PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return models;
  return models.map((model) => {
    const known = preset.fallbackModels.find((fallback) => fallback.id === model.id);
    if (!known) return model;
    return {
      ...model,
      ...(known.wire !== undefined ? { wire: known.wire } : {}),
      ...(known.url !== undefined ? { url: known.url } : {}),
      ...(known.authHeader !== undefined ? { authHeader: known.authHeader } : {}),
    };
  });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
}

/**
 * The model a connection test should use, when the preset names one that speaks the wire the test
 * speaks (Chat Completions).
 *
 * The catalogue's first entry is whatever the vendor happened to list first, and OpenCode lists its
 * free tier there. Measured 2026-09-22: `big-pickle`, the head of Zen's catalogue, answers 403
 * FreeTierError — "OpenCode's free tier can only be used from within OpenCode" — while
 * `claude-fable-5` on the same key answers 402. Testing with the head therefore reported a paying
 * account as refused, and pointed the operator at a key that was never the problem.
 *
 * The preset's own list is picked from deliberately, and only its Chat entries: the test posts to
 * Chat Completions, so a Responses-only model like Muse Spark would answer 503 and look broken.
 */
function presetProbeModel(presetId: string | undefined): string | undefined {
  const preset = presetId ? PRESETS.find((entry) => entry.id === presetId) : undefined;
  if (!preset) return undefined;
  return preset.fallbackModels.find((model) => (model.wire ?? preset.wire ?? "chat") === "chat")?.id;
}

async function probeProvider(body: ProbeRequest, probeFetch: (url: string, init: RequestInit) => Promise<Response> = fetchWithTimeout): Promise<{ ok: boolean; auth: ProbeAuth; models: ModelEntry[]; error?: string }> {
  const source = headerValue(body.headers);
  let models: ModelEntry[] = [];
  let modelsError: string | undefined;
  if (body.modelsUrl) {
    try {
      const response = await probeFetch(body.modelsUrl, { headers: authHeaders(source, body.modelsAuthHeader) });
      if (response.status === 401 || response.status === 403) return { ok: false, auth: "bad-key", models: [], error: `models endpoint returned ${response.status}` };
      if (response.ok) models = withPresetOverrides(parsedModels(await response.json()), body.preset);
      else modelsError = `models endpoint returned ${response.status}`;
    } catch (e) {
      modelsError = `models endpoint: ${errorText(e)}`;
    }
  }

  const openai = body.type === "openai-compatible";
  // A preset's test model is picked for Chat Completions (see `presetProbeModel`), so only a provider
  // entered by hand is tested on Responses: one that serves nothing else answered the Chat test 404.
  const responses = openai && body.wire === "responses" && !body.preset;
  const checkUrl = responses ? responsesUrl(body.url) : openai ? chatCompletionsUrl(body.url) : messagesUrl(body.url);
  const checkModel = presetProbeModel(body.preset) ?? models[0]?.id ?? body.probeModel ?? "test";
  // 16 tokens, as on Responses: some vendors refuse a smaller cap outright (B.ai: "max_tokens must be
  // greater than 2", #57), which read as a failed connection though the key and URL were right.
  // Streamed, as every translated turn is: the status arrives with the headers, while a reasoning
  // model answering whole can take past the timeout (Hive: 0.3s streamed, 3–23s whole, 2026-10-18).
  const checkBody = responses
    ? { model: checkModel, max_output_tokens: 16, stream: true, store: false, input: "hi" }
    : openai
      ? { model: checkModel, max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }
      : { model: checkModel, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  const label = responses ? "responses endpoint" : openai ? "chat completions endpoint" : "messages endpoint";
  try {
    const response = await probeFetch(checkUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(body.sessionHeader ? { [body.sessionHeader]: `probe-${crypto.randomBytes(8).toString("hex")}` } : {}),
        ...authHeaders(source),
      },
      body: JSON.stringify(checkBody),
    });
    if (response.status === 401 || response.status === 403) {
      const refusal = snippet(await response.text());
      const auth: ProbeAuth = response.status === 403 && refusedByPlan(refusal) ? "not-entitled" : "bad-key";
      return { ok: false, auth, models, error: `${label} returned ${response.status}: ${refusal}` };
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: true, auth: "ok", models, ...(modelsError ? { error: modelsError } : {}) };
    }
    const detail = snippet(await response.text());
    // A model-validation refusal still demonstrates that the endpoint reached the provider and the key was accepted.
    if (refusedForModel(response.status, detail)) {
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

/**
 * Measure what each model's wire and effort ladder actually is, in the background, and settle the
 * answers into the config.
 *
 * A model absent from a preset's table inherits the provider's default wire and is sent to an
 * endpoint that may not serve it — OpenCode Go answers 503 on the wrong wire (measured 2026-09-22),
 * which surfaces as an unexplained 529. `/models` carries no capability metadata to avoid that, so
 * the only source is a real request. A measurement sends several small ones, so it runs detached
 * and the caller polls the job instead of holding a request open for it.
 */
type MeasureJob = { state: "running" | "done" | "failed"; done: number; total: number; results: Measured[]; error?: string; /** Epoch ms the job finished, for the TTL sweep. Internal: not part of the polled shape. */ finishedAt?: number };
const MEASURE_JOBS = new Map<string, MeasureJob>();
/** Measured capability does not change minute to minute, so a finished job is served for a while
 * and then dropped: a test or a GUI that polls late should re-measure rather than hold the result
 * (and its error strings) in memory for the life of the process. */
const MEASURE_JOB_TTL_MS = 10 * 60 * 1000;
const MEASURE_TIMEOUT_MS = 20_000;
/** Models measured at once. One job is one provider and one key, so this is also its burst. */
const MEASURE_CONCURRENCY = 4;

async function measureFetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(MEASURE_TIMEOUT_MS) });
}

/** Drop finished jobs past their TTL. Run on each measure request, so no timer keeps the process up. */
function sweepMeasureJobs(): void {
  const cutoff = Date.now() - MEASURE_JOB_TTL_MS;
  for (const [id, job] of MEASURE_JOBS) if (job.state !== "running" && job.finishedAt !== undefined && job.finishedAt < cutoff) MEASURE_JOBS.delete(id);
}

/**
 * The wires a model of this provider might speak, in the order they are worth trying.
 *
 * The preset's own entry for this exact model goes first when there is one. Order decides the
 * answer, because the first wire to reply wins — and a plan can serve one model on two of them:
 * measured 2026-09-22, `minimax-m3` answers on both Chat Completions and Anthropic Messages, so
 * trying the list in catalogue order made it measure as `chat` and quietly overrule the `anthropic`
 * the preset recorded for it. A recorded wire is still only a starting point: it has to answer like
 * any other candidate, and the rest of the list is tried when it does not.
 *
 * `catalogWire` is the wire the public catalogue gives this model (catalog.ts). It goes first when
 * the preset's own table says nothing about the model, so a model newer than that table is still
 * settled in one request instead of walking the list.
 */
function measureCandidates(p: Provider, modelId?: string, catalogWire?: WireCandidate["wire"]): WireCandidate[] {
  const defaultWire: "chat" | "responses" | "anthropic" =
    p.type === "anthropic-compatible" ? "anthropic"
      : p.type === "openai-compatible" ? (p.wire ?? "chat")
        : "chat";
  const ownUrl = "url" in p ? p.url : "";
  const ownHeader = "authHeader" in p ? (p as { authHeader?: "x-api-key" | "authorization-bearer" }).authHeader : undefined;
  const own: WireCandidate = { wire: defaultWire, url: ownUrl, ...(ownHeader ? { authHeader: ownHeader } : {}) };
  const candidates: WireCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: WireCandidate): void => {
    const key = `${c.wire}|${c.url}|${c.authHeader ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };
  const known = "preset" in p && p.preset
    ? PRESETS.find((entry) => entry.id === p.preset)?.fallbackModels?.find((m) => m.id === modelId)
    : undefined;
  // The Gemini wire is not one `capabilities.ts` speaks: it has its own endpoint shape and header,
  // so a model the preset records on it is not tried on the other three (a request there would
  // answer 404/protocol-error and read as a model the plan refuses). Its wire stays as declared.
  if (known?.wire && known.wire !== "google") add({ wire: known.wire, url: known.url ?? ownUrl, ...(known.authHeader ? { authHeader: known.authHeader } : {}) });
  add(own);
  if (p.type === "openai-compatible" && p.preset) {
    // One plan can serve several wires on one catalog. The preset's fallback list is the only place
    // any of that mapping is written down, so it is what the remaining candidates are read from.
    const preset = PRESETS.find((entry) => entry.id === p.preset);
    for (const model of preset?.fallbackModels ?? []) {
      if (model.wire === "google") continue;
      add({ wire: model.wire ?? defaultWire, url: model.url ?? p.url, ...(model.authHeader ? { authHeader: model.authHeader } : {}) });
    }
  } else if (p.type === "openai-compatible") {
    // No table to read: the two OpenAI wires this kind of provider could be serving.
    add({ wire: "responses", url: p.url });
    add({ wire: "chat", url: p.url });
  } else if (p.type === "anthropic-compatible" && p.preset) {
    const preset = PRESETS.find((entry) => entry.id === p.preset);
    for (const model of preset?.fallbackModels ?? []) if (model.wire && model.wire !== "google") add({ wire: model.wire, url: model.url ?? p.url, ...(model.authHeader ? { authHeader: model.authHeader } : {}) });
  }
  if (!known?.wire && catalogWire) {
    const at = candidates.findIndex((c) => c.wire === catalogWire);
    if (at > 0) candidates.unshift(...candidates.splice(at, 1));
  }
  return candidates;
}

/** The effort ladder this provider offers, before any per-model override narrows it. */
function providerLadder(p: Provider): string[] {
  if (p.type === "openai-compatible") return p.caps?.reasoning === "effort" ? [...(p.caps.effortLevels ?? [])] : [];
  if (p.type === "anthropic-compatible") return [...(p.caps?.effortLevels ?? [])];
  return [];
}

/**
 * Whether nothing says what effort this provider's models take, so a request strips it: the case
 * worth measuring a model for. Read the way the request path reads it. An anthropic-compatible
 * provider falls back to its preset live (`compatCaps` in proxy.ts) and strips on an empty ladder; the
 * OpenAI adapter reads only its own `caps`, and `reasoning: "effort"` with no levels passes effort
 * through as asked. An anthropic-compatible ladder the config states is a decision, even an empty
 * one. `reasoning: "none"` is not: the provider form writes it for every OpenAI-compatible provider
 * whose preset has no ladder (Groq, Mistral, a key and a URL), with no control to say otherwise.
 */
function effortUndeclared(p: Provider): boolean {
  if (p.type === "anthropic-compatible") {
    if (p.caps?.effortLevels !== undefined) return false;
    const preset = p.preset ? PRESETS.find((entry) => entry.id === p.preset) : undefined;
    return (preset?.effortLevels ?? []).length === 0;
  }
  if (p.type === "openai-compatible") return p.caps?.reasoning !== "effort";
  return false;
}

/** Ollama's native API base when this provider is Ollama (local daemon or cloud), else null. */
function ollamaBase(p: Provider): string | null {
  return p.type === "openai-compatible" ? ollamaApiBase(p.url, p.preset) : null;
}

/**
 * Fold measurements into the config on disk.
 *
 * Read again here rather than reusing what the job started with: the user may have saved from the
 * GUI while the measurements ran, and writing back a stale copy would silently revert that save.
 * Only a model that is still present is touched, and only into a blank field — a `wire`,
 * `effortLevels` or `contextWindow` already on the model is the user's or the vendor's, and an
 * explicitly empty ladder is a decision
 * (it disables the provider fallback), not an empty slot. Ollama is the exception
 * (`replaceEmptyEffort`): there the empty ladder is what an unread capability was saved as, so the
 * vendor's own `/api/show` answer takes its place. A model whose measurement errored is left
 * entirely alone. The result is validated with the same `validate` the GUI's save uses, so a bad
 * edit is refused rather than written.
 */
function applyMeasurements(configFile: string, providerName: string, results: Measured[], options: { replaceEmptyEffort?: boolean } = {}): { applied: number } | { error: string } {
  let current: Config;
  try {
    current = JSON.parse(fs.readFileSync(configFile, "utf8")) as Config;
  } catch (e) {
    return { error: `could not re-read config: ${errorText(e)}` };
  }
  const provider = current.providers[providerName];
  if (!provider?.models) return { applied: 0 };
  let applied = 0;
  for (const result of results) {
    if (result.error || !result.wire) continue;
    const model = provider.models.find((entry) => entry.id === result.id);
    if (!model) continue;
    const before = `${model.wire ?? ""}|${model.effortLevels ? model.effortLevels.join(",") : "∅"}|${model.contextWindow ?? "∅"}`;
    if (model.wire === undefined) model.wire = result.wire;
    const blankEffort = model.effortLevels === undefined || (options.replaceEmptyEffort === true && model.effortLevels.length === 0);
    if (blankEffort && result.effortLevels !== undefined) model.effortLevels = result.effortLevels;
    if (model.contextWindow == null && result.contextWindow !== undefined) model.contextWindow = result.contextWindow;
    if (`${model.wire ?? ""}|${model.effortLevels ? model.effortLevels.join(",") : "∅"}|${model.contextWindow ?? "∅"}` !== before) applied++;
  }
  const errors = validate(current);
  if (errors.length > 0) return { error: `measured config did not validate: ${errors[0]}` };
  writeConfigFile(configFile, current);
  return { applied };
}

/** Register a measurement job and run it detached; returns the id a caller polls. */
function startMeasureJob(providerName: string, models: string[], deps: AdminDeps): string {
  sweepMeasureJobs();
  const jobId = crypto.randomBytes(12).toString("hex");
  MEASURE_JOBS.set(jobId, { state: "running", done: 0, total: models.length, results: [] });
  deps.log.info(`admin: measuring ${providerName} (${models.length} model(s)) -> ${jobId.slice(0, 8)}`);
  void runMeasureJob(jobId, providerName, models, deps);
  return jobId;
}

/**
 * Measure the models whose effort is still stripped and that nobody has settled, without waiting
 * for a save in the GUI. A model was measured only when its provider was saved, so a provider set up
 * before effort discovery — every DeepSeek, Kimi or GLM key on 0.8.1 and earlier — would otherwise
 * stay without effort until its owner happened to save it again. A model with a ladder (measured,
 * or typed) is the config's and left alone; so is one whose provider declares a ladder. Ollama is
 * the exception: an empty ladder there is what a probe that could never see its thinking levels left
 * behind, so it is measured again and replaced by what `/api/show` states.
 */
export function measureUnsettledModels(deps: AdminDeps): number {
  let started = 0;
  for (const [name, provider] of Object.entries(deps.config().providers)) {
    if (provider.type !== "openai-compatible" && provider.type !== "anthropic-compatible") continue;
    const ollama = ollamaBase(provider) !== null;
    const undeclared = effortUndeclared(provider);
    if (!undeclared && !ollama) continue;
    const models = (provider.models ?? [])
      .filter((model) => (undeclared && model.effortLevels === undefined) || (ollama && model.effortLevels !== undefined && model.effortLevels.length === 0))
      .map((model) => model.id);
    if (models.length === 0) continue;
    startMeasureJob(name, models, deps);
    started++;
  }
  return started;
}

/**
 * Give models already saved without a context window the one the catalogue states.
 *
 * OpenCode's `/models` reports ids alone, so a provider set up before the catalogue's `limit.context`
 * was read keeps no window and falls back to `cli.autoCompactWindow` — a quarter of a 1M model's real
 * window. Hive's `/models` states even less, and it has no catalogue block of its own, so a model
 * saved there is matched against the catalogue by id (`catalogueWindow`). The measurement folds the
 * catalogue's window in, but only over the models it runs on and only through its own write; this
 * pass reaches the models already on disk, once, at start-up. Only into a blank field, through the
 * same validated write, so a window the user or the vendor set is never overwritten. Returns the
 * `provider/model` ids it filled.
 */
export async function backfillContextWindows(deps: AdminDeps): Promise<string[]> {
  const catalog = deps.modelCatalog ? await deps.modelCatalog().catch(() => undefined) : undefined;
  if (!catalog) {
    deps.log.warn("admin: context windows not backfilled: the catalogue could not be had");
    return [];
  }
  let current: Config;
  try {
    current = JSON.parse(fs.readFileSync(deps.configFile, "utf8")) as Config;
  } catch (e) {
    deps.log.warn(`admin: context windows not backfilled: could not read config: ${errorText(e)}`);
    return [];
  }
  const filled: string[] = [];
  for (const [name, provider] of Object.entries(current.providers)) {
    if (!("models" in provider) || !provider.models) continue;
    const preset = "preset" in provider ? provider.preset : undefined;
    for (const model of provider.models) {
      // A saved `null` is as blank as a missing field (configs written by older dashboards carry it).
      if (model.contextWindow != null) continue;
      const stated = catalogEntry(catalog, preset, model.id)?.contextWindow ?? catalogueWindow(catalog, model.id);
      if (stated === undefined) continue;
      model.contextWindow = stated;
      filled.push(`${name}/${model.id}`);
      deps.log.info(`admin: ${name}/${model.id} context window ${stated} (catalogue)`);
    }
  }
  if (filled.length === 0) return [];
  const errors = validate(current);
  if (errors.length > 0) {
    deps.log.warn(`admin: context windows not backfilled: config did not validate: ${errors[0]}`);
    return [];
  }
  writeConfigFile(deps.configFile, current);
  return filled;
}

/**
 * Declare each Claude release the account has gained on every native Anthropic provider that
 * declares an older model of the same family (`newClaudeReleases`). The declared list was whatever
 * was ticked when the provider was saved, so Opus 5.5, Sonnet 5.5 and Haiku 5.5 stayed off it for
 * weeks while Claude Code had them (2026-10-08). A model offered once is remembered in
 * `claude-models-offered.json` and never offered again, so unticking a new model sticks.
 * Returns the `provider/model` ids it declared.
 */
export async function adoptNewClaudeModels(deps: AdminDeps): Promise<string[]> {
  const live = await deps.claudeModels?.().catch(() => null);
  if (!live?.length) return [];
  const stateFile = path.join(homeDir(), "claude-models-offered.json");
  let offered = new Set<string>();
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { offered?: unknown };
    if (Array.isArray(saved.offered)) offered = new Set(saved.offered.filter((id): id is string => typeof id === "string"));
  } catch { /* first run: nothing offered yet */ }
  let current: Config;
  try {
    current = JSON.parse(fs.readFileSync(deps.configFile, "utf8")) as Config;
  } catch (e) {
    deps.log.warn(`admin: claude models not adopted: could not read config: ${errorText(e)}`);
    return [];
  }
  const added: string[] = [];
  for (const [name, provider] of Object.entries(current.providers)) {
    if (provider.type !== "anthropic" || !provider.models?.length) continue;
    for (const model of newClaudeReleases(live, provider.models.map((entry) => entry.id), offered)) {
      provider.models.push({ id: model.id, name: model.name ?? model.id });
      added.push(`${name}/${model.id}`);
    }
  }
  if (added.length) {
    const errors = validate(current);
    if (errors.length > 0) {
      deps.log.warn(`admin: claude models not adopted: config did not validate: ${errors[0]}`);
      return [];
    }
    writeConfigFile(deps.configFile, current);
    deps.log.info(`admin: declared new Claude model(s): ${added.join(", ")}`);
  }
  fs.writeFileSync(stateFile, JSON.stringify({ offered: [...new Set([...offered, ...live.map((model) => model.id)])].sort() }, null, 2) + "\n");
  return added;
}

/** Run one provider measurement job to completion. Detached: the request that started it has already answered. */
async function runMeasureJob(jobId: string, providerName: string, models: string[], deps: AdminDeps): Promise<void> {
  const job = MEASURE_JOBS.get(jobId);
  if (!job) return;
  const provider = deps.config().providers[providerName];
  if (!provider || (provider.type !== "openai-compatible" && provider.type !== "anthropic-compatible")) {
    MEASURE_JOBS.set(jobId, { ...job, state: "failed", error: `provider "${providerName}" is not openai-compatible or anthropic-compatible` });
    return;
  }
  const ladder = providerLadder(provider);
  // No ladder from the provider, its preset or the config: find out per model whether it takes
  // effort at all (`discoverLadder`), rather than leave it stripped.
  const discover = effortUndeclared(provider);
  const fetchImpl = deps.measureFetch ?? measureFetchWithTimeout;
  const headers = "headers" in provider ? provider.headers : undefined;
  const sessionHeader = "sessionHeader" in provider ? provider.sessionHeader : undefined;
  const preset = "preset" in provider ? provider.preset : undefined;
  const ollama = ollamaBase(provider);
  const catalog = deps.modelCatalog ? await deps.modelCatalog().catch(() => undefined) : undefined;
  const measureOne = async (id: string): Promise<void> => {
    const listed = catalogEntry(catalog, preset, id);
    // Per model, not once per job: the order depends on what the preset recorded for this id.
    const candidates = measureCandidates(provider, id, listed?.wire);
    // A ladder the catalogue states is taken as stated; the wire is still asked, once, because that
    // one request is also what finds a model the plan refuses (403 FreeTierError, DataPolicyError).
    const stated = ladder.length > 0 || discover ? listed?.effortLevels : undefined;
    const known = stated !== undefined;
    // Ollama states thinking levels and the context length itself; a probe cannot see either, and
    // its unknown-field probe measures every thinking model as taking no effort. Its own `/api/show`
    // answers first, and the ladder probing it would only answer wrongly is skipped.
    const facts = ollama ? await ollamaModelFacts(ollama, id, { fetch: fetchImpl, ...(sessionHeader ? { sessionHeader } : {}), ...(headers ? { headers } : {}) }) : undefined;
    const measured = await measureModel(id, candidates, known || facts ? [] : ladder, { fetch: fetchImpl, ...(sessionHeader ? { sessionHeader } : {}), ...(headers ? { headers } : {}) }, { discover: discover && !known && !facts });
    if (stated && measured.wire) measured.effortLevels = stated;
    if (facts) {
      // An answer without levels is a model that takes no effort: a fact, not a blank.
      measured.effortLevels = facts.effortLevels ?? [];
      if (facts.contextWindow !== undefined) measured.contextWindow = facts.contextWindow;
    }
    // The wire was answered, so the model exists: the catalogue's own window travels with the result
    // and is written only into a model that has none (see applyMeasurements). A provider without a
    // catalogue block of its own is matched by id instead (`catalogueWindow`).
    const window = listed?.contextWindow ?? catalogueWindow(catalog, id);
    if (measured.wire && window !== undefined) measured.contextWindow = window;
    job.results.push(measured);
    job.done++;
    deps.log.info(`admin: measured ${providerName}/${id} -> ${measured.error ? `error ${measured.error}` : `wire ${measured.wire}${measured.effortLevels ? ` effort ${measured.effortLevels.join(",")}${known ? " (catalogue)" : facts ? " (ollama)" : ""}` : ""}`}`);
  };
  // Models are independent, so a few run at once and a slow upstream answer holds up only its own
  // model. Levels inside one model stay sequential: a burst there invites 429s, and a level that
  // meets one is kept rather than measured, which would quietly widen the ladder.
  const queue = [...models];
  await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) await measureOne(id);
  }));
  try {
    const outcome = applyMeasurements(deps.configFile, providerName, job.results, { replaceEmptyEffort: ollama !== null });
    if ("error" in outcome) {
      MEASURE_JOBS.set(jobId, { ...job, state: "failed", error: outcome.error, finishedAt: Date.now() });
      deps.log.warn(`admin: measurement for ${providerName} was not applied: ${outcome.error}`);
      return;
    }
    deps.log.info(`admin: measurement for ${providerName} applied to ${outcome.applied} model(s)`);
    MEASURE_JOBS.set(jobId, { ...job, state: "done", finishedAt: Date.now() });
  } catch (e) {
    MEASURE_JOBS.set(jobId, { ...job, state: "failed", error: errorText(e), finishedAt: Date.now() });
  }
}

async function pickerModels(deps: AdminDeps): Promise<{ models: { id: string; name: string }[]; source: "picker" | "fallback" }> {  const last = deps.picker?.().last;
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
      if (injected.has(e.id) || seen.has(e.id) || isJudgeOnlyModel(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    if (models.length > 0) return { models, source: "picker" };
  }
  return { models: await claudeModelList(deps), source: "fallback" };
}

/**
 * Each model's context window for the phone and dashboard. ChatGPT-served models use the same
 * effective resolution as bootstrap/picker: a window the operator saved on a picker entry wins, then
 * the catalogue figure, and an explicit route window wins over both. Without a catalogue window, the
 * stored values retain their old precedence. Unknown is absent. `catalogWindows` carries each
 * catalogue-backed id's own figure — also when an override is in effect — for the picker editor's
 * default; `windows` is the value actually resolved. `resolvedWindows` binds a capacity (null when
 * unknown) to its target/provider for usage readers; unlike the legacy editor maps it never
 * substitutes a native alias or global compaction window.
 */
async function contextWindows(deps: AdminDeps): Promise<ReturnType<typeof contextWindowSnapshot>> {
  return contextWindowSnapshot(deps.config(), await claudeModelList(deps), deps.agentDir ? [deps.agentDir] : undefined);
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
  // Clients that ask for /favicon.ico without reading the page's <link rel="icon"> get the PNG;
  // browsers sniff the bytes, so a PNG served for .ico shows.
  const rel = decoded === "/" ? "index.html" : decoded === "/favicon.ico" ? "favicon-32.png" : decoded.replace(/^\/+/, "");
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
  // Standalone admin users share the same coordinator, but only the router entry starts scheduling.
  const updater = deps.autoUpdater ?? new AutoUpdater({
    home: homeDir(), version: deps.version, enabled: () => deps.config().autoUpdate !== false,
    activity: () => ({ inFlight: 0 }), log: deps.log,
    runCli: deps.runCli ?? runCli, startCliDetached: deps.startCliDetached ?? startCliDetached,
  });
  deps = { ...deps, autoUpdater: updater };
  const scores = new ModelScoreCatalog({ home: homeDir(), warn: message => deps.log.warn(message), ...(deps.modelScoresFetch ? { fetch: deps.modelScoresFetch } : {}) });
  // Set again once the socket is bound (port 0 in tests); the Origin check below compares against it.
  let boundPort = adminPort(deps.config());
  /** The dashboard's `awake setup` run in progress (or the last one), for GET /api/power/setup. */
  let powerSetup: { running: boolean; startedAt?: string; finishedAt?: string; ok?: boolean; output?: string } = { running: false };
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  /** Binding to loopback alone does not stop DNS rebinding: check Host even on reads. */
  function localHost(req: http.IncomingMessage): boolean {
    return [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(req.headers.host ?? "");
  }

  /** Cross-site browser writes still act despite CORS. CLI and tray forwarding send no Origin. */
  function crossSiteOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return false;
    return ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`].includes(origin);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    // A HEAD is a GET whose body is discarded, and Node discards it for us: measured 2026-09-22,
    // the response goes out with its `content-length` and no bytes after the headers. Normalising
    // it here lets every read-only route answer one, where matching on "GET" alone fell through to
    // 404 — which reads as a dead router to anything that checks with a HEAD.
    const method = req.method === "HEAD" ? "GET" : (req.method ?? "GET");
    const pathname = url.split("?")[0] ?? "/";
    try {
      if (!localHost(req)) {
        deps.log.warn(`admin: refused ${method} ${pathname} with non-loopback Host`);
        sendJson(res, 403, { error: "local admin host required" });
        return;
      }
      if (method !== "GET" && crossSiteOrigin(req)) {
        deps.log.warn(`admin: refused ${method} ${pathname} from origin ${String(req.headers.origin)}`);
        sendJson(res, 403, { error: "cross-site request refused" });
        return;
      }
      if (pathname === "/api/settings-jobs" || pathname === "/api/settings-jobs/claim" || pathname === "/api/settings-jobs/result") {
        res.setHeader("cache-control", "no-store");
        if (crossSiteOrigin(req) || req.headers["sec-fetch-site"] === "cross-site") { sendJson(res, 403, { error: "same-origin phone control required" }); return; }
        const isList = pathname === "/api/settings-jobs";
        if (method !== (isList ? "GET" : "POST")) { sendJson(res, 404, { error: "unknown phone endpoint or method" }); return; }
        let body: string | undefined, exclude: string | undefined;
        if (isList) {
          const query = new URL(url, "http://127.0.0.1").searchParams;
          exclude = query.get("exclude") ?? undefined;
          if (!settingsId(exclude) || query.getAll("exclude").length !== 1) { sendJson(res, 400, { error: "invalid helper" }); return; }
        } else {
          try { body = (await readBody(req, 4096, new Error("settings job body too large"))).toString("utf8"); }
          catch { sendJson(res, 400, { error: "invalid settings job request" }); return; }
          let raw: unknown;
          try { raw = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid settings job request" }); return; }
          if (!validSettingsJobAction(raw, pathname.endsWith("/result"))) { sendJson(res, 400, { error: "invalid settings job request" }); return; }
        }
        const route = isList ? "settings-jobs" : `settings-jobs/${pathname.endsWith("/claim") ? "claim" : "result"}`;
        const result = await phoneRequest(route, method, body, deps.phone, exclude);
        sendJson(res, result.status, result.body); return;
      }
      if (pathname === "/api/phone-inbox" || pathname === "/api/phone-inbox/claim" || pathname === "/api/phone-inbox/result") {
        res.setHeader("cache-control", "no-store");
        if (crossSiteOrigin(req) || req.headers["sec-fetch-site"] === "cross-site") {
          sendJson(res, 403, { error: "same-origin phone control required" }); return;
        }
        const isList = pathname === "/api/phone-inbox";
        if (method !== (isList ? "GET" : "POST")) { sendJson(res, 404, { error: "unknown phone endpoint or method" }); return; }
        let body: string | undefined;
        let session: string | undefined;
        if (isList) {
          const query = new URL(url, "http://127.0.0.1").searchParams;
          session = query.get("session") ?? undefined;
          if (!session || session.length > 200 || query.getAll("session").length !== 1) { sendJson(res, 400, { error: "invalid session" }); return; }
        } else {
          try { body = (await readBody(req, 4096, new Error("inbox body too large"))).toString("utf8"); }
          catch { sendJson(res, 400, { error: "invalid inbox request" }); return; }
          let raw: unknown;
          try { raw = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid inbox request" }); return; }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) { sendJson(res, 400, { error: "invalid inbox request" }); return; }
          const value = raw as Record<string, unknown>;
          const result = pathname.endsWith("/result");
          if (typeof value.itemId !== "string" || !/^[\w-]{1,100}$/.test(value.itemId) || Object.keys(value).some(key => key !== "itemId" && (!result || key !== "outcome")) || result && value.outcome !== "submitted" && value.outcome !== "failed") {
            sendJson(res, 400, { error: "invalid inbox request" }); return;
          }
        }
        const route = isList ? "inbox" : `inbox/${pathname.endsWith("/claim") ? "claim" : "result"}`;
        const result = await phoneRequest(route, method, body, deps.phone, session);
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname.startsWith("/api/phone/")) {
        res.setHeader("cache-control", "no-store");
        // Pairing is a credential read: guard cross-site GETs too. Host is checked above.
        if (crossSiteOrigin(req) || req.headers["sec-fetch-site"] === "cross-site") {
          sendJson(res, 403, { error: "same-origin phone control required" });
          return;
        }
        let body: string | undefined;
        if (method === "POST" && pathname === "/api/phone/settings") {
          try { body = (await readBody(req, 4096, new Error("phone settings too large"))).toString("utf8"); }
          catch { sendJson(res, 413, { error: "phone settings too large" }); return; }
        }
        const result = await phoneRequest(pathname.slice("/api/phone/".length), method, body, deps.phone);
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === "/api/shutdown" && method === "POST") {
        if (!deps.shutdown) {
          sendJson(res, 501, { error: "shutdown not available" });
          return;
        }
        // A caller that names an installation must name the one this process actually is (captured
        // at start, not read from disk now). A caller that names none is an older CLI.
        const claimed = req.headers["x-clauderipple-install-id"];
        if (typeof claimed === "string") {
          const ours = deps.instance?.installId ?? null;
          if (ours && claimed !== ours) {
            sendJson(res, 409, { error: "installation mismatch" });
            return;
          }
        }
        // Answer before draining: the caller needs to know the request was accepted, and the
        // drain can outlive the connection (it waits for in-flight model calls, up to 90s).
        sendJson(res, 202, { draining: true });
        deps.shutdown();
        return;
      }
      if (pathname === "/api/remote" && method === "GET") {
        if (!deps.remote) { sendJson(res, 501, { error: "remote tunnels not available" }); return; }
        sendJson(res, 200, { hosts: deps.remote.status() });
        return;
      }
      if (pathname === "/api/remote/reload" && method === "POST") {
        if (!deps.remote) { sendJson(res, 501, { error: "remote tunnels not available" }); return; }
        sendJson(res, 200, { hosts: deps.remote.reload() });
        return;
      }
      if (pathname === "/api/power" && (method === "GET" || method === "PUT")) {
        if (!deps.power) { sendJson(res, 501, { error: "power control not available" }); return; }
        if (method === "GET") { sendJson(res, 200, deps.power.status()); return; }
        let parsed: unknown;
        try {
          parsed = JSON.parse((await readBody(req, 4096)).toString("utf8"));
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        const change = parsePowerChange(parsed);
        if (typeof change === "string") { sendJson(res, 400, { error: change }); return; }
        if (persistPowerChange(deps.configFile, change)) {
          deps.log.info(`admin: power saved (${JSON.stringify({ ...(change.awake ? { awake: change.awake } : {}), ...(change.tether?.enabled !== undefined ? { tether: { enabled: change.tether.enabled } } : {}) })})`);
        }
        if (change.tether?.pin !== undefined) deps.power.pin(change.tether.pin);
        await deps.power.poke();
        sendJson(res, 200, deps.power.status());
        return;
      }
      // The one privileged step, from the dashboard: the CLI's `awake setup`, which shows macOS's own
      // password dialog. It runs in the background and is polled, like the ChatGPT sign-in: the user
      // may take minutes to type, and the app's window gives up on a response with no headers after
      // 4s (packages/app/src/protocol.ts) — a reply held open until the end would read as a dead router.
      if (pathname === "/api/power/setup" && (method === "GET" || method === "POST")) {
        if (!deps.power) { sendJson(res, 501, { error: "power control not available" }); return; }
        if (method === "GET") { sendJson(res, 200, powerSetup); return; }
        let parsed: unknown;
        try {
          const text = (await readBody(req, 4096)).toString("utf8");
          parsed = text.trim() ? JSON.parse(text) : {};
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { sendJson(res, 400, { error: "expected an object" }); return; }
        const extra = Object.keys(parsed).find((key) => key !== "ssid");
        if (extra) { sendJson(res, 400, { error: `unknown field "${extra}"` }); return; }
        const ssid = (parsed as { ssid?: unknown }).ssid;
        if (ssid !== undefined) {
          // Checked here too so a bad name is refused before a password dialog, not after it.
          const problem = ssidProblem(ssid);
          if (problem) { sendJson(res, 400, { error: problem }); return; }
        }
        if (powerSetup.running) { sendJson(res, 409, { error: "setup is already running", running: true }); return; }
        powerSetup = { running: true, startedAt: new Date().toISOString() };
        const args = ["awake", "setup", ...(typeof ssid === "string" ? ["--ssid", ssid] : [])];
        deps.log.info(`admin: awake setup via GUI -> started${typeof ssid === "string" ? ` (hotspot "${ssid}")` : ""}`);
        const power = deps.power;
        // The CLI's own dialog times out at 5 min; this leaves it room to say so itself.
        void (deps.runCli ?? runCli)(args, 330_000).then(
          (result) => ({ ok: result.ok, output: result.output }),
          (error: unknown) => ({ ok: false, output: errorText(error) }),
        ).then(async (result) => {
          powerSetup = { ...powerSetup, running: false, finishedAt: new Date().toISOString(), ...result };
          deps.log.info(`admin: awake setup via GUI -> ${result.ok ? "ok" : "failed"}`);
          // Re-read whether the rule is in place now, so the next GET /api/power says so.
          try { await power.poke(); } catch { /* the next tick does it */ }
        });
        sendJson(res, 202, { started: true });
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
        const refresh = new URL(url, "http://127.0.0.1").searchParams.get("refresh") === "1";
        sendJson(res, 200, await buildStatus(deps, { refresh }));
        return;
      }
      // One shape for every provider whose quota can be read, for the status bar's limits row.
      if (pathname === "/api/limits" && method === "GET") {
        sendJson(res, 200, await buildLimits(deps));
        return;
      }
      if (pathname === "/api/mod-settings" && method === "GET") {
        const snapshot = readModSettings();
        // Filled here as well as on save, so a ladder with empty rungs (Auto migrated, or never set) reads whole to every surface.
        sendJson(res, 200, { ...snapshot, settings: await withFilledLadder(deps, scores, snapshot.settings) });
        return;
      }
      if (pathname === "/api/mod-settings" && method === "PUT") {
        const bytes = await readBody(req, MAX_BODY, new ModSettingsInputError("body too large", 413));
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString("utf8")); }
        catch { throw new ModSettingsInputError("invalid JSON"); }
        validateSettingsSchema(parsed);
        const body = parsed as { settings?: unknown; compactAt?: unknown };
        // The compaction point lives in Claude Code's own settings.json, not the mod's store: a
        // dashboard save writes the same key `/autocompact` does, or removes it for the default.
        if (body && typeof body === "object" && body.compactAt !== undefined) {
          if (body.compactAt !== null && typeof body.compactAt !== "number") throw new ModSettingsInputError("compactAt must be a number of tokens or null");
          writeAutoCompactWindow(body.compactAt);
          syncContextWindows(deps.config(), deps.agentDir ? [deps.agentDir] : undefined);
        }
        if (body && typeof body === "object" && body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
          // Checked before normalizing, which would drop a credential field the check is there to refuse.
          validateSettings(body.settings);
          body.settings = await withFilledLadder(deps, scores, normalizeSettings(body.settings));
        }
        if (!body || typeof body !== "object" || body.settings === undefined) {
          if (body && typeof body === "object" && body.compactAt !== undefined) {
            // A compaction-point-only save: its answer is the same snapshot shape the dashboard reads.
            const snapshot = readModSettings();
            sendJson(res, 200, { ...snapshot, settings: await withFilledLadder(deps, scores, snapshot.settings) });
            return;
          }
          throw new ModSettingsInputError("settings must be a JSON object");
        }
        const result = writeModSettings(parsed);
        sendJson(res, result.stale ? 409 : 200, result.current);
        return;
      }
      if (pathname === "/api/mod-options" && method === "GET") {
        sendJson(res, 200, await modOptions(deps, scores));
        return;
      }
      if (pathname === "/api/presets" && method === "GET") {
        sendJson(res, 200, { presets: PRESETS satisfies ProviderPreset[] });
        return;
      }
      if (pathname === "/api/claude-models" && method === "GET") {
        sendJson(res, 200, await pickerModels(deps));
        return;
      }
      if (pathname === "/api/context-windows" && method === "GET") {
        sendJson(res, 200, await contextWindows(deps));
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
        const probe = parsed as { type?: unknown; name?: unknown; auth?: unknown; apiKey?: unknown; url?: unknown; headers?: unknown; modelsUrl?: unknown; modelsAuthHeader?: unknown; probeModel?: unknown; sessionHeader?: unknown; preset?: unknown; wire?: unknown; home?: unknown; cli?: unknown; clientVersion?: unknown };
        if (probe.type === "anthropic") {
          if (probe.auth === "claude-code") {
            sendJson(res, 200, await probeClaudeCodeAuth(deps));
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
          // Which provider to ask: the form knows the one it is editing, and a provider merely
          // configured by hand is the only other candidate. Unknown name → ask nobody, show the
          // measured fallback, which is also what an unreachable catalogue yields.
          const providers = deps.config().providers;
          const named = typeof probe.name === "string" && providers[probe.name]?.type === "chatgpt" ? probe.name : undefined;
          const providerName = named ?? Object.entries(providers).find(([, p]) => p.type === "chatgpt")?.[0];
          const live = providerName ? await deps.chatgpt?.().models?.(providerName) : undefined;
          const models = live?.length ? live : CHATGPT_FALLBACK_MODELS;
          sendJson(res, 200, {
            ok: signed,
            auth: signed ? (statuses[0] ?? "ok") : "missing",
            ...(signed ? {} : { error: "no ChatGPT credentials: sign in from the tray menu, or install and sign in to the Codex CLI" }),
            models,
            modelsSource: live?.length ? "catalog" : "fallback",
          });
          return;
        }
        if (probe.type === "grok") {
          sendJson(res, 200, await probeGrok(probe, deps.log, deps.probeFetch));
          return;
        }
        if (probe.type === "google") {
          if (probe.auth === "antigravity") {
            sendJson(res, 200, await probeGoogleAntigravity(deps));
            return;
          }
          sendJson(res, 200, await probeGoogle({ apiKey: probe.apiKey, url: probe.url }, deps.probeFetch));
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
          ...(typeof probe.sessionHeader === "string" && probe.sessionHeader ? { sessionHeader: probe.sessionHeader } : {}),
          ...(probe.modelsAuthHeader ? { modelsAuthHeader: probe.modelsAuthHeader } : {}),
          ...(typeof probe.preset === "string" && probe.preset ? { preset: probe.preset } : {}),
          ...(typeof probe.probeModel === "string" ? { probeModel: probe.probeModel } : {}),
          ...(probe.wire === "chat" || probe.wire === "responses" ? { wire: probe.wire } : {}),
        }, deps.probeModelFetch ?? fetchWithTimeout);
        // A provider being added gets the same blank-only fill as one already saved: Hive's `/models`
        // names its models and nothing else, and the form saves what the probe returns. A window the
        // vendor did report is kept, and one the catalogue cannot match is left blank.
        const missing = result.models.filter((model) => model.contextWindow == null);
        if (missing.length > 0 && deps.modelCatalog) {
          const catalog = await deps.modelCatalog().catch(() => undefined);
          const preset = typeof probe.preset === "string" && probe.preset ? probe.preset : undefined;
          for (const model of missing) {
            const stated = catalogEntry(catalog, preset, model.id)?.contextWindow ?? catalogueWindow(catalog, model.id);
            if (stated !== undefined) model.contextWindow = stated;
          }
        }
        sendJson(res, 200, result);
        return;
      }
      // Measure what each model's wire and effort ladder actually is, in the background: a job is
      // several small upstream requests, and the caller polls /api/providers/measure/<jobId> rather
      // than holding a request open for all of them.
      if (pathname === "/api/providers/measure" && method === "POST") {
        let body: { provider?: unknown; models?: unknown };
        try {
          body = JSON.parse((await readBody(req)).toString("utf8")) as { provider?: unknown; models?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (typeof body.provider !== "string" || !Array.isArray(body.models) || body.models.some((m) => typeof m !== "string")) {
          sendJson(res, 400, { error: "expected {provider: string, models: string[]}" });
          return;
        }
        const provider = deps.config().providers[body.provider];
        if (!provider || (provider.type !== "openai-compatible" && provider.type !== "anthropic-compatible")) {
          sendJson(res, 400, { error: `provider "${body.provider}" is not openai-compatible or anthropic-compatible` });
          return;
        }
        const jobId = startMeasureJob(body.provider, body.models as string[], deps);
        sendJson(res, 202, { jobId, total: body.models.length });
        return;
      }
      if (pathname.startsWith("/api/providers/measure/") && method === "GET") {
        const jobId = pathname.slice("/api/providers/measure/".length).split("/")[0] ?? "";
        const job = MEASURE_JOBS.get(jobId);
        if (!job) {
          sendJson(res, 404, { error: "unknown or expired measure job" });
          return;
        }
        // The polled shape, without the sweep's own bookkeeping field.
        const { finishedAt: _finishedAt, ...view } = job;
        sendJson(res, 200, view);
        return;
      }
      if (pathname === "/api/config" && method === "GET") {
        res.setHeader("cache-control", "no-store");
        const { configRevision } = configSnapshot(deps);
        sendJson(res, 200, { ...deps.config(), configRevision });
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
        let input: unknown;
        try {
          input = JSON.parse(body.toString("utf8"));
        } catch (e) {
          sendJson(res, 400, { errors: [`invalid JSON: ${(e as Error).message}`] });
          return;
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          sendJson(res, 400, { errors: ["config must be a JSON object"] });
          return;
        }
        const { configRevision, ...parsed } = input as Config & { configRevision?: unknown };
        if (configRevision !== undefined && (typeof configRevision !== "string" || !/^[a-f0-9]{64}$/.test(configRevision))) {
          sendJson(res, 400, { errors: ["configRevision must be a SHA-256 hex string"] });
          return;
        }
        // No await between comparison and atomic rename: two admin windows cannot both win.
        const current = configSnapshot(deps);
        if (configRevision !== undefined && configRevision !== current.configRevision) {
          sendJson(res, 409, { error: "config revision conflict", ...current });
          return;
        }
        const errors = validate(parsed);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        if (configRevision === undefined) deps.log.warn("admin: accepting legacy PUT /api/config without configRevision; conflict protection unavailable");
        writeConfigFile(deps.configFile, parsed);
        deps.log.info(`admin: config saved via GUI (${Object.keys(parsed.routes).length} routes, ${Object.keys(parsed.providers).length} providers)`);
        // `cli.models` cannot take effect through the router at all: Claude Code reads the slots
        // before a request exists. So a GUI save has to write them to settings.json itself;
        // otherwise the Clients screen shows a choice that only a later `install` would honour.
        const slotWarning = syncModelSlotsForGui(parsed, deps.agentDir);
        const warnings = [...(slotWarning ? [slotWarning] : []), ...targetWarnings(parsed)];
        sendJson(res, 200, { ok: true, configRevision: configSnapshot(deps).configRevision, ...(warnings.length ? { warning: warnings.join("\n") } : {}) });
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
        sendJson(res, 200, { ...chatgptLogin, signedIn: chatgptSignedIn(provider?.auth), accountCount: readChatGptAccounts(homeDir()).length });
        return;
      }
      // Safe account metadata only: labels, emails, plan, rotation state and quota. Tokens and the
      // workspace id stay in the router.
      if (pathname === "/api/credentials/clear-cooldown" && method === "POST") {
        let change: { provider?: unknown; id?: unknown };
        try {
          change = JSON.parse((await readBody(req)).toString("utf8")) as typeof change;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!change || typeof change.provider !== "string" || typeof change.id !== "string") {
          sendJson(res, 400, { error: "expected {provider: string, id: string}" });
          return;
        }
        const provider = deps.config().providers[change.provider];
        if (!provider || !("credentials" in provider) || !provider.credentials?.some((credential) => credential.id === change.id)) {
          sendJson(res, 404, { error: "credential not found" });
          return;
        }
        if (!deps.clearCredentialCooldown) {
          sendJson(res, 501, { error: "credential cooldown control unavailable" });
          return;
        }
        deps.clearCredentialCooldown(change.provider, change.id);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === "/api/chatgpt-accounts" && method === "GET") {
        const all = deps.chatgpt?.().accounts?.() ?? {};
        const wanted = new URL(url, "http://127.0.0.1").searchParams.get("provider");
        const name = wanted && all[wanted] ? wanted : Object.keys(all)[0];
        const accounts = name ? all[name]! : previewAccounts(readChatGptAccounts(homeDir()).map(summarizeChatGptAccount));
        sendJson(res, 200, { provider: name ?? null, accounts });
        return;
      }
      if (pathname.startsWith("/api/chatgpt-accounts/") && (method === "PATCH" || method === "DELETE")) {
        let id: string;
        try {
          id = decodeURIComponent(pathname.slice("/api/chatgpt-accounts/".length));
        } catch {
          sendJson(res, 400, { error: "invalid account id" });
          return;
        }
        const own = id === "legacy" || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
        if (!own && id !== "codex") {
          sendJson(res, 400, { error: "invalid account id" });
          return;
        }
        if (method === "DELETE") {
          if (id === "codex") {
            sendJson(res, 409, { error: "the Codex CLI's login belongs to Codex; sign out there instead" });
            return;
          }
          if (!removeChatGptAccount(homeDir(), id)) {
            sendJson(res, 404, { error: "ChatGPT account not found" });
            return;
          }
          deps.log.info(`admin: removed ChatGPT account ${id.slice(0, 8)}`);
          sendJson(res, 200, { ok: true });
          return;
        }
        let change: { label?: unknown; paused?: unknown; preferred?: unknown; clearCooldown?: unknown };
        try {
          change = JSON.parse((await readBody(req)).toString("utf8")) as typeof change;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!change || (change.label !== undefined && (typeof change.label !== "string" || !change.label.trim())) || (change.paused !== undefined && typeof change.paused !== "boolean") || (change.preferred !== undefined && typeof change.preferred !== "boolean") || (change.clearCooldown !== undefined && change.clearCooldown !== true)) {
          sendJson(res, 400, { error: "expected {label?: non-empty string, paused?: boolean, preferred?: boolean, clearCooldown?: true}" });
          return;
        }
        if (id !== "codex" && !readChatGptAccounts(homeDir()).some((account) => account.id === id)) {
          sendJson(res, 404, { error: "ChatGPT account not found" });
          return;
        }
        if (change.label !== undefined || change.paused !== undefined || change.preferred !== undefined) {
          if (id === "codex") {
            sendJson(res, 409, { error: "the Codex CLI's login cannot be renamed or paused here" });
            return;
          }
          if (!updateChatGptAccount(homeDir(), id, { ...(typeof change.label === "string" ? { label: change.label } : {}), ...(typeof change.paused === "boolean" ? { paused: change.paused } : {}), ...(typeof change.preferred === "boolean" ? { preferred: change.preferred } : {}) })) {
            sendJson(res, 404, { error: "ChatGPT account not found" });
            return;
          }
        }
        if (change.clearCooldown === true) deps.chatgpt?.().clearCooldown?.(id);
        deps.log.info(`admin: updated ChatGPT account ${id.slice(0, 8)}`);
        sendJson(res, 200, { ok: true });
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
      // Safe account metadata only. The current Claude Code/Desktop source remains externally owned;
      // ClaudeRipple accounts can be renamed or removed by their local opaque id.
      if (pathname === "/api/claude-accounts" && method === "GET") {
        const source = claudeAuthStore(deps).describeSource();
        let usage: Record<string, Record<string, unknown>> = {};
        if (hasClaudeSubscription(deps.config())) usage = (await deps.claudeUsage?.().catch(() => null)) ?? {};
        // Only a known current login can point out a stored copy of itself; unknown adds nothing,
        // so the response stays exactly what it was before there was an identity lookup.
        const identity = source ? (await deps.claudeIdentity?.().catch(() => null)) ?? null : null;
        const wanted = new URL(url, "http://127.0.0.1").searchParams.get("provider");
        const providers = Object.entries(deps.config().providers).filter(([, provider]) => provider.type === "anthropic" && provider.auth === "claude-code");
        const name = providers.find(([key]) => key === wanted)?.[0] ?? providers[0]?.[0];
        const projection = new ClaudeAccountAuthPool({ home: homeDir(), current: claudeAuthStore(deps), log: deps.log }).peekCredentials();
        const reports = (name ? deps.credentials?.()[name] : undefined)
          ?? new CredentialPool().report(name ?? "claude", projection).map((row) => ({ ...row, id: projection.find((credential) => credential.id === row.id)!.ownerId! }));
        const accounts = listClaudeAccountsWithSubject(homeDir()).map(({ subjectHash: hash, ...account }) => {
          const same = identity !== null && (hash !== undefined
            ? hash === identity.subjectHash
            : account.email !== undefined && account.email.toLowerCase() === identity.email.toLowerCase());
          const report = reports.find((row) => row.id === account.id);
          return {
            ...account,
            state: account.paused ? "paused" : account.needsReauth || account.expiresAt <= Date.now() ? "needs-login" : report?.state ?? "ready",
            inUse: report?.inUse === true,
            ...(report?.cooldownSeconds !== undefined ? { cooldownSeconds: report.cooldownSeconds } : {}),
            ...(usage[account.id] ? { quota: usage[account.id] } : {}),
            ...(same ? { sameAsCurrent: true } : {}),
          };
        });
        const currentReport = reports.find((row) => row.id === "current");
        sendJson(res, 200, {
          current: source ? {
            id: "current",
            label: "Current Claude login",
            source,
            external: true,
            paused: false,
            preferred: false,
            state: currentReport?.state ?? "needs-login",
            inUse: currentReport?.inUse === true,
            ...(currentReport?.cooldownSeconds !== undefined ? { cooldownSeconds: currentReport.cooldownSeconds } : {}),
            ...(identity ? { email: identity.email } : {}),
            ...(usage.current ? { quota: usage.current } : {}),
          } : null,
          accounts,
        });
        return;
      }
      // Which account a new conversation tries first: a stored account id, or null for the current login.
      if (pathname === "/api/claude-accounts" && method === "PUT") {
        let preferred: unknown;
        try {
          preferred = (JSON.parse((await readBody(req)).toString("utf8")) as { preferred?: unknown }).preferred;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (preferred === "current") preferred = null;
        if (preferred !== null && (typeof preferred !== "string" || !preferred)) {
          sendJson(res, 400, { error: "expected {preferred: account id or null}" });
          return;
        }
        if (!setPreferredClaudeAccount(homeDir(), preferred)) {
          sendJson(res, 404, { error: "Claude account not found" });
          return;
        }
        deps.log.info(`admin: Claude accounts now try ${preferred === null ? "the current login" : `account ${preferred.slice(0, 8)}`} first`);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname.startsWith("/api/claude-accounts/") && (method === "PATCH" || method === "DELETE")) {
        let id: string;
        try {
          id = decodeURIComponent(pathname.slice("/api/claude-accounts/".length));
        } catch {
          sendJson(res, 400, { error: "invalid account id" });
          return;
        }
        const validId = id === "legacy" || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
        if (!validId || id === "current") {
          sendJson(res, id === "current" ? 409 : 400, { error: id === "current" ? "the current Claude login is managed by Claude Code or Claude Desktop" : "invalid account id" });
          return;
        }
        if (method === "DELETE") {
          if (!removeClaudeAccount(homeDir(), id)) {
            sendJson(res, 404, { error: "Claude account not found" });
            return;
          }
          deps.log.info(`admin: removed Claude account ${id.slice(0, 8)}`);
          sendJson(res, 200, { ok: true });
          return;
        }
        let change: { label?: unknown; paused?: unknown; preferred?: unknown; clearCooldown?: unknown };
        try {
          change = JSON.parse((await readBody(req)).toString("utf8")) as typeof change;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!change || (change.label !== undefined && (typeof change.label !== "string" || !change.label.trim())) || (change.paused !== undefined && typeof change.paused !== "boolean") || (change.preferred !== undefined && typeof change.preferred !== "boolean") || (change.clearCooldown !== undefined && change.clearCooldown !== true)) {
          sendJson(res, 400, { error: "expected {label?: non-empty string, paused?: boolean, preferred?: boolean, clearCooldown?: true}" });
          return;
        }
        if (!updateClaudeAccount(homeDir(), id, {
          ...(typeof change.label === "string" ? { label: change.label } : {}),
          ...(typeof change.paused === "boolean" ? { paused: change.paused } : {}),
          ...(typeof change.preferred === "boolean" ? { preferred: change.preferred } : {}),
        })) {
          sendJson(res, 404, { error: "Claude account not found" });
          return;
        }
        if (change.clearCooldown === true) deps.claudeClearCooldown?.(id);
        deps.log.info(`admin: updated Claude account ${id.slice(0, 8)}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      // Claude subscription sign-in of our own (browser, PKCE). The GUI starts it, polls the state,
      // and pastes the code when the loopback port could not be used. Tokens never leave the router.
      if (pathname === "/api/claude-oauth" && method === "GET") {
        const state: ClaudeOAuthState & { source: string | null } = { ...(claudeOAuth?.snapshot ?? { running: false, url: null, manual: false, startedAt: null, finishedAt: null, ok: null, error: null, account: null }), source: claudeAuthStore(deps).describeSource() };
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
      // Google (Antigravity) sign-in of our own (browser, PKCE, loopback callback). The GUI starts it
      // and polls the state; tokens never leave the router and never appear in any response.
      if (pathname === "/api/google-login" && method === "GET") {
        const state: GoogleOAuthState = googleOAuth?.snapshot ?? { running: false, url: null, startedAt: null, finishedAt: null, ok: null, error: null, account: null, termsWarning: ANTIGRAVITY_WARNING };
        sendJson(res, 200, state);
        return;
      }
      if (pathname === "/api/google-login" && method === "POST") {
        if (googleOAuth?.snapshot.running) {
          sendJson(res, 200, googleOAuth.snapshot);
          return;
        }
        const session = new GoogleOAuthSession({ home: homeDir(), ...(deps.googleOAuthFetch ? { fetch: deps.googleOAuthFetch } : {}), ...(deps.googleOAuthPort !== undefined ? { port: deps.googleOAuthPort } : {}) }, ANTIGRAVITY_WARNING);
        googleOAuth = session;
        let started: { url: string; port: number };
        try {
          started = await session.start();
        } catch (error) {
          sendJson(res, 500, { ...session.snapshot, error: (error as Error).message });
          return;
        }
        const opened = deps.openBrowser ? deps.openBrowser(started.url) : openBrowser(started.url);
        deps.log.info(`admin: google sign-in via GUI -> started (browser ${opened ? "opened" : "not opened"})`);
        void session.result.then(
          () => deps.log.info("admin: google sign-in via GUI -> ok"),
          (error: Error) => deps.log.info(`admin: google sign-in via GUI -> failed: ${error.message}`),
        );
        sendJson(res, 200, { ...session.snapshot, opened, termsWarning: ANTIGRAVITY_WARNING });
        return;
      }
      if (pathname === "/api/google-login/code" && method === "POST") {
        const session = googleOAuth;
        if (!session?.snapshot.running) {
          sendJson(res, 409, { error: "no Google sign-in is waiting for a code" });
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
      if (pathname === "/api/google-login/cancel" && method === "POST") {
        googleOAuth?.cancel();
        sendJson(res, 200, googleOAuth?.snapshot ?? { running: false });
        return;
      }
      if (pathname === "/api/google-logout" && method === "POST") {
        const r = await (deps.runCli ?? runCli)(["google-logout"]);
        deps.log.info(`admin: google-logout via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
        return;
      }
      // Safe account metadata only: labels, emails, project ids and rotation state. Tokens stay in
      // the router and are never serialized.
      if (pathname === "/api/google-accounts" && method === "GET") {
        const all = deps.google?.().accounts?.() ?? {};
        const wanted = new URL(url, "http://127.0.0.1").searchParams.get("provider");
        const name = wanted && all[wanted] ? wanted : Object.keys(all)[0];
        const accounts = name ? all[name]! : previewAccounts(readGoogleAccounts(homeDir()).map(summarizeGoogleAccount));
        sendJson(res, 200, { provider: name ?? null, accounts });
        return;
      }
      if (pathname.startsWith("/api/google-accounts/") && (method === "PATCH" || method === "DELETE")) {
        let id: string;
        try {
          id = decodeURIComponent(pathname.slice("/api/google-accounts/".length));
        } catch {
          sendJson(res, 400, { error: "invalid account id" });
          return;
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
          sendJson(res, 400, { error: "invalid account id" });
          return;
        }
        if (method === "DELETE") {
          if (!removeGoogleAccount(homeDir(), id)) {
            sendJson(res, 404, { error: "Google account not found" });
            return;
          }
          deps.log.info(`admin: removed Google account ${id.slice(0, 8)}`);
          sendJson(res, 200, { ok: true });
          return;
        }
        let change: { label?: unknown; paused?: unknown; preferred?: unknown; clearCooldown?: unknown; recheck?: unknown };
        try {
          change = JSON.parse((await readBody(req)).toString("utf8")) as typeof change;
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        if (!change || (change.label !== undefined && (typeof change.label !== "string" || !change.label.trim())) || (change.paused !== undefined && typeof change.paused !== "boolean") || (change.preferred !== undefined && typeof change.preferred !== "boolean") || (change.clearCooldown !== undefined && change.clearCooldown !== true)) {
          sendJson(res, 400, { error: "expected {label?: non-empty string, paused?: boolean, preferred?: boolean, clearCooldown?: true, recheck?: true}" });
          return;
        }
        if (!readGoogleAccounts(homeDir()).some((account) => account.id === id)) {
          sendJson(res, 404, { error: "Google account not found" });
          return;
        }
        if (change.recheck === true) {
          const result = (await deps.google?.().recheckVerification?.(id)) ?? "unknown";
          deps.log.info(`admin: rechecked Google verification for ${id.slice(0, 8)} -> ${result}`);
          sendJson(res, 200, { ok: true, verification: result });
          return;
        }
        if (change.clearCooldown === true) deps.google?.().clearCooldown?.(id);
        if (change.label !== undefined || change.paused !== undefined || change.preferred !== undefined) {
          if (!updateGoogleAccount(homeDir(), id, { ...(typeof change.label === "string" ? { label: change.label } : {}), ...(typeof change.paused === "boolean" ? { paused: change.paused } : {}), ...(typeof change.preferred === "boolean" ? { preferred: change.preferred } : {}) })) {
            sendJson(res, 404, { error: "Google account not found" });
            return;
          }
        }
        deps.log.info(`admin: updated Google account ${id.slice(0, 8)}`);
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
      if (pathname === "/api/update" && (method === "GET" || method === "POST")) {
        // The CLI answers both: it knows how this copy was installed, which decides what an update is
        // (the tray asks it the same way). A POST checks again rather than trusting the page.
        const r = await (deps.runCli ?? runCli)(["update", "--check", "--json"], 30_000);
        const check = r.ok ? parseUpdateCheck(r.output) : null;
        if (!check) {
          sendJson(res, 502, { error: "could not check for updates", output: r.output.slice(-2000) });
          return;
        }
        updater.observe(check);
        const running = updater.running();
        if (method === "GET") {
          sendJson(res, 200, { ...check, running });
          return;
        }
        if (check.kind !== "script" && check.kind !== "npm") {
          sendJson(res, 409, { error: `this copy (${check.kind}) is not updated from here`, ...check });
          return;
        }
        if (!check.newer) {
          sendJson(res, 409, { error: "already the latest version", ...check });
          return;
        }
        if (running) {
          sendJson(res, 409, { error: "an update is already running", ...check, running });
          return;
        }
        const log = updater.install(check);
        deps.log.info(`admin: update ${check.current} -> ${check.latest ?? "?"} started via GUI (output in ${log})`);
        sendJson(res, 202, { started: true, ...check, log });
        return;
      }
      if (pathname === "/api/image" && method === "POST") {
        // The image itself is the response body, so `curl -o out.png` is the whole client. An error
        // is JSON with a non-2xx status (`curl --fail-with-body` writes it to the same file).
        if (!deps.image) {
          sendJson(res, 501, { error: "image generation not available" });
          return;
        }
        let parsed: ImageRequest | string;
        try {
          parsed = parseImageRequest(JSON.parse((await readBody(req, MAX_IMAGE_BODY)).toString("utf8")));
        } catch (e) {
          sendJson(res, 400, { error: /too large/.test((e as Error).message) ? "body too large (reference images over 32 MB)" : "invalid JSON" });
          return;
        }
        if (typeof parsed === "string") {
          sendJson(res, 400, { error: parsed });
          return;
        }
        // A caller that gives up should not leave the generation running on the subscription.
        const abort = new AbortController();
        res.on("close", () => { if (!res.writableFinished) abort.abort(); });
        // The CLI's own session, so the request log shows which session generated the image.
        const session = req.headers["x-claude-code-session-id"];
        const meta = typeof session === "string" && /^[\w-]{1,128}$/.test(session) ? { session } : undefined;
        const started = Date.now();
        try {
          const image = await deps.image(parsed, abort.signal, meta);
          deps.log.info(`admin: image ${image.size ?? "?"} ${image.quality ?? "?"} ${image.format}, ${parsed.images?.length ?? 0} reference(s), ${image.data.length} bytes in ${Date.now() - started} ms`);
          res.writeHead(200, {
            "content-type": `image/${image.format}`,
            "content-length": String(image.data.length),
            ...(image.size ? { "x-image-size": image.size } : {}),
            ...(image.quality ? { "x-image-quality": image.quality } : {}),
            ...(image.revisedPrompt ? { "x-revised-prompt": encodeURIComponent(image.revisedPrompt) } : {}),
          });
          res.end(image.data);
        } catch (e) {
          deps.log.warn(`admin: image failed after ${Date.now() - started} ms: ${(e as Error).message}`);
          if (!res.headersSent) sendJson(res, 502, { error: (e as Error).message });
        }
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
      if (pathname === "/api/status-mod" && method === "POST") {
        // Through the CLI, like agent-title: it knows where this install keeps packages/mod.
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
        const r = await runCli(["mod", enabled ? "on" : "off"]);
        deps.log.info(`admin: status mod ${enabled ? "on" : "off"} via GUI -> ${r.ok ? "ok" : "failed"}`);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, output: r.output });
        return;
      }
      if (pathname === "/api/requests" && method === "GET") {
        const query = new URL(url, "http://x").searchParams;
        const requested = Number(query.get("n") ?? 200);
        const n = Number.isFinite(requested) ? Math.min(2000, Math.max(1, Math.floor(requested))) : 200;
        const provider = query.get("provider") || undefined;
        const session = query.get("session") || undefined;
        const kindValue = query.get("kind");
        // A comma-separated list so one call can ask for several kinds; unknown entries are ignored
        // and a list with nothing valid left means no filter.
        const kinds = kindValue === null ? [] : kindValue.split(",").filter((k): k is "messages" | "count_tokens" | "other" | "image" => k === "messages" || k === "count_tokens" || k === "other" || k === "image");
        sendJson(res, 200, { requests: deps.requests.list(n, { ...(provider ? { provider } : {}), ...(kinds.length ? { kind: kinds } : {}), ...(session ? { session } : {}) }) });
        return;
      }
      if (pathname === "/api/requests/summary" && method === "GET") {
        const query = new URL(url, "http://x").searchParams;
        const fromParam = query.get("from");
        if (fromParam !== null) {
          const from = Number(fromParam);
          const toParam = query.get("to");
          const to = toParam === null ? Date.now() : Number(toParam);
          if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
            sendJson(res, 400, { error: "from and to must be epoch milliseconds with from <= to" });
            return;
          }
          sendJson(res, 200, { ...deps.requests.usage(from, to), from, to });
          return;
        }
        const seconds = Number(query.get("since") ?? 3600);
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
      if (e instanceof ModSettingsInputError && !res.headersSent) {
        sendJson(res, e.status, { error: e.message });
        return;
      }
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
