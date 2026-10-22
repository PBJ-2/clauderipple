"use strict";


function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = Boolean(value);
    // A textarea ignores the `value` attribute, so a form reopened on a saved provider showed an
    // empty box and its save wiped what was there (instructionsAppend, 2026-09-23).
    else if (key === "value" && tag === "textarea") node.value = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children || []) {
    if (child !== null && child !== undefined) node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Inside the ClaudeRipple app the page is the app's own copy, so it is here even with the router
// down; window.rippleApp is how it asks the app for what only the app can do (repair, the direct
// switch). In a browser the object is absent and none of the app-only parts are drawn.
const APP = window.rippleApp || null;
if (APP) {
  document.documentElement.classList.add("in-app", `platform-${APP.platform}`);
  // Korean wraps between words in the app's own sentences (style.css :lang(ko)).
  document.documentElement.lang = CURRENT_LANG;
}
/** The router's admin API answered 503 "routerDown" (the app's way of saying it is not running). */
let routerDown = false;
/** What the app last said about the connection (doctor, a running repair, …); see renderConnection. */
let shellState = null;

let toastTimer = null;
function toast(message, isError, raw) {
  const box = $("#toast");
  box.replaceChildren(el("div", { text: message }));
  if (raw) box.appendChild(el("div", { class: "toast-raw", text: raw }));
  box.classList.toggle("error", Boolean(isError));
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), isError ? 6500 : 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const raw = (body.errors || [body.error || body.raw || `HTTP ${res.status}`]).join("; ");
    const error = new Error(raw);
    error.body = body;
    error.status = res.status;
    throw error;
  }
  return body;
}

// The router writes `cli.models` to settings.json on this save (they only take effect there). If
// that write could not happen it says so here — a slot that silently does nothing is the bug this
// call used to be, so a failure must reach the screen rather than the router log.
async function configRequest(next) {
  const out = await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
  if (out && out.warning) toast(out.warning, true);
  return out;
}

// A save sends the whole config, so it starts from what the router holds now rather than the copy
// this screen loaded: the router writes config.json too (measured wires and effort ladders, hand
// edits), and a save built on an old copy put all of that back. Seen 2026-10-02: adding a provider
// restored three OpenCode ladders realigned five hours earlier, so the app's effort menus never narrowed.
async function latestConfig() {
  try { currentConfig = await api("/api/config"); } catch { /* the save that follows reports an unreachable router */ }
  return currentConfig;
}

function modelsOf(provider) {
  const value = (provider && provider.models) || [];
  return value.map((model) => typeof model === "string" ? { id: model, name: model } : model).filter((model) => model && model.id);
}
function labelOf(model) { return model.name || model.id; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeName(value) { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""); }
// A name with no Latin letters ("하이브") slugs to nothing: fall back to the URL's domain ("thehive").
function domainWord(url) {
  try { const parts = new URL(url).hostname.split("."); return safeName(parts.length > 1 ? parts[parts.length - 2] : parts[0]); } catch { return ""; }
}
function uniqueName(name, providers, url) {
  const base = safeName(name) || (url ? domainWord(url) : "") || "provider";
  let value = base;
  let number = 2;
  while (providers[value]) value = `${base}-${number++}`;
  return value;
}
/**
 * A base URL as providers are compared: scheme and host lowercased, no trailing slash on the path.
 * Two entries that differ only in case or a trailing "/" are the same service, and the router's
 * pool is per provider, so a second entry would split one account's keys into two rotations.
 */
function normalizedBaseUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, "");
    const query = parsed.search || "";
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${query}`;
  } catch { return raw.replace(/\/+$/, "").toLowerCase(); }
}
/** The provider already serving this base URL, as `[name, provider]`, or null. */
function providerByBaseUrl(providers, url) {
  const wanted = normalizedBaseUrl(url);
  if (!wanted) return null;
  // Only key-based providers take keys from the merge: ChatGPT, Google and Grok sign in instead,
  // and a Claude subscription provider has its own account list.
  for (const [name, provider] of Object.entries(providers || {})) {
    if (!isKeyBasedProvider(provider)) continue;
    if (normalizedBaseUrl(provider.url) === wanted) return [name, provider];
  }
  return null;
}
function groupedModels(config) {
  const groups = [];
  for (const [name, provider] of Object.entries(config.providers || {})) {
    // A native Claude provider becomes a mapping target only after the explicit account-pool opt-in.
    // API-key and legacy login providers remain OpenAI-ingress-only.
    if (provider.type === "anthropic" && !provider.accountPool) continue;
    let models = modelsOf(provider);
    if (!models.length && provider.type === "chatgpt") models = CHATGPT_MODELS;
    if (models.length) groups.push({ name, provider, models });
  }
  return groups;
}
function presetById(id) { return presets.find((preset) => preset.id === id); }
function modelEffortLevels(provider, model) {
  const entry = modelsOf(provider).find((item) => item.id === model);
  return entry && Array.isArray(entry.effortLevels) ? entry.effortLevels : undefined;
}
// The ChatGPT ladders the Codex catalogue reports (measured 2026-09-23): every model takes
// low..max, and only these add ultra. The live probe replaces this table when it can be reached.
const CHATGPT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CHATGPT_ULTRA_MODELS = new Set(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]);
function fallbackEffortLevels(provider, model) {
  if (!provider) return [];
  const explicit = modelEffortLevels(provider, model);
  if (explicit !== undefined) return explicit;
  if (provider.type === "chatgpt") return CHATGPT_ULTRA_MODELS.has(model) ? [...CHATGPT_EFFORT_LEVELS, "ultra"] : [...CHATGPT_EFFORT_LEVELS];
  // What the router's grok adapter sends a model the proxy's listing has not described.
  if (provider.type === "grok") return ["low", "medium", "high", "xhigh"];
  const preset = provider.preset && presetById(provider.preset);
  if (provider.type === "openai-compatible") return provider.caps && provider.caps.reasoning === "effort" && Array.isArray(provider.caps.effortLevels) ? provider.caps.effortLevels : [];
  return provider.caps && Array.isArray(provider.caps.effortLevels) ? provider.caps.effortLevels : (preset && preset.effortLevels) || [];
}
function effortLevelsFor(providerName, model) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[providerName];
  const catalog = effortCatalog && effortCatalog.providers && effortCatalog.providers[providerName];
  if (catalog) return (catalog.models && catalog.models[model]) || catalog.default || [];
  return fallbackEffortLevels(provider, model);
}
function providerSupportsEffort(provider, model) {
  return fallbackEffortLevels(provider, model).length > 0;
}
function hasModelEffortData(provider) {
  return modelsOf(provider).some((model) => Array.isArray(model.effortLevels));
}
function modelEffortTag(model) {
  if (!Array.isArray(model.effortLevels)) return null;
  return model.effortLevels.length ? t("providers.modelEffort") : t("providers.modelNoEffort");
}
// Routed models do not share a context window, so each picker entry carries its own. What the user
// typed wins; otherwise whatever the vendor's /models reported (`context_length`); otherwise the
// global cli.autoCompactWindow fallback. This is the model's real window, not a compaction point.
function discoveredContextWindow(providerName, modelId) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[providerName];
  const entry = provider && modelsOf(provider).find((item) => item.id === modelId);
  return entry && Number.isFinite(entry.contextWindow) ? entry.contextWindow : undefined;
}
function savedContextWindow(modelId) {
  const entry = ((currentConfig && currentConfig.cli && currentConfig.cli.extraModels) || []).find((item) => item.model === modelId);
  return entry && Number.isFinite(entry.contextWindow) ? entry.contextWindow : undefined;
}

let currentConfig = null;
let status = null;
let loadedUiRevision = null;
let claudeModels = FALLBACK_CLAUDE_MODELS;
let presets = FALLBACK_PRESETS;
let effortCatalog = null;
let slotsLoaded = false;
let providersLoaded = false;
let clientsLoaded = false;
let pickerBusy = false;
let probeStates = new Map();
let chatgptLoginBusy = false;
let chatgptLoginMessage = "";
let phoneGeneration = 0;
let phoneSnapshot = null;
let phoneQrGeneration = 0;
let phoneBusy = false;

function selectOption(value, text) { return el("option", { value }, [text]); }
function badge(kind, text) { return el("span", { class: `badge ${kind} dot`, text }, []); }
function hint(text) { return el("p", { class: "hint", text }, []); }
/** One row of an inset group: a label (and quieter lines under it) on the left, a value or control on the right. */
function cell(label, value, sub, extraClass) {
  const lines = (Array.isArray(sub) ? sub : [sub]).filter(Boolean).map((line) => typeof line === "string" ? el("span", { class: "cell-sub", text: line }) : line);
  return el("div", { class: `cell${extraClass ? ` ${extraClass}` : ""}` }, [
    el("div", { class: "cell-text" }, [typeof label === "string" ? el("span", { class: "cell-label", text: label }) : label, ...lines]),
    value ? el("div", { class: "cell-value" }, Array.isArray(value) ? value : [value]) : null,
  ]);
}
/** A titled group of rows with an optional note under it — the System Settings section shape. */
function section(title, rows, footer, action) {
  return el("section", { class: "section" }, [
    title || action ? el("div", { class: "section-head" }, [title ? el("h3", { class: "section-title", text: title }) : el("span"), action || null]) : null,
    el("div", { class: "group" }, rows.filter(Boolean)),
    ...(Array.isArray(footer) ? footer : [footer]).filter(Boolean).map((text) => el("p", { class: "group-footer", text })),
  ]);
}
const SVG_NS = "http://www.w3.org/2000/svg";
/** A small line icon; the paths are drawn in currentColor so the icon follows the text around it. */
function svgIcon(viewBox, paths, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
function chevronIcon() { return svgIcon("0 0 8 13", ["M1.5 1.5l5 5-5 5"], "chevron"); }

function showView(name) {
  if (name !== "phone") { phoneGeneration++; hidePhoneQr(); }
  for (const button of $all(".nav-btn")) button.classList.toggle("active", button.dataset.view === name);
  for (const view of $all(".view")) view.classList.toggle("active", view.id === `view-${name}`);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  applyOffline();
  // With the router down (inside the app) a page has nothing to load; it says so instead of
  // failing, and loads when the router is back (setRouterDown).
  if (offline()) return;
  if (name === "phone") queueMicrotask(() => void loadPhone());
  if (name === "mac") queueMicrotask(() => void loadMac());
  if (name === "slots" && !slotsLoaded) void loadSlots();
  if (name === "providers" && !providersLoaded) void loadProviders();
  if (name === "clients" && !clientsLoaded) void loadClients();
  if (name === "logs") queueMicrotask(() => void refreshRequests());
  // Read again on every visit: the bar's ⚙ panel saves the same settings.
  if (name === "mod") queueMicrotask(() => void loadMod());
  // Quotas move while a page is open, so arriving at a page is a good moment to look again.
  // Deferred: the first showView runs before the usage panel's state is declared.
  queueMicrotask(() => void refreshUsage());
}
for (const button of $all(".nav-btn")) button.addEventListener("click", () => showView(button.dataset.view));
window.addEventListener("hashchange", () => showView((location.hash || "#health").slice(1)));
showView((location.hash || "#health").slice(1) || "health");

// The sidebar carries one language menu and About another (the sidebar is a tab bar on a phone).
(function setupLanguage() {
  const lang = (typeof CURRENT_LANG !== "undefined" && CURRENT_LANG) || "en";
  for (const select of $all(".lang-select")) {
    for (const [code, name] of LANGUAGES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      option.selected = code === lang;
      select.append(option);
    }
    select.addEventListener("change", () => {
      try { localStorage.setItem("clauderipple_lang", select.value); } catch { /* unavailable */ }
      location.reload();
    });
  }
})();

async function loadCatalogs() {
  const [modelResult, presetResult, effortResult] = await Promise.allSettled([api("/api/claude-models"), api("/api/presets"), api("/api/effort-levels")]);
  if (modelResult.status === "fulfilled" && Array.isArray(modelResult.value.models) && modelResult.value.models.length) claudeModels = modelResult.value.models;
  if (presetResult.status === "fulfilled" && Array.isArray(presetResult.value.presets) && presetResult.value.presets.length) presets = presetResult.value.presets;
  if (effortResult.status === "fulfilled" && effortResult.value && effortResult.value.providers) effortCatalog = effortResult.value;
}

// ---- Status -------------------------------------------------------------------------

async function refreshHealth() {
  try {
    status = await api("/api/status");
  } catch (error) {
    $("#health-desktop").replaceChildren(cell(t("health.connection"), badge("bad", t("health.disconnected"))));
    // Inside the app a router that does not answer is a state with a way out, not an error.
    if (APP && error.body && error.body.routerDown) setRouterDown(true);
    return;
  }
  if (APP) setRouterDown(false);
  // Served files changed underneath an open window (e.g. after an update): reload, unless a form is open.
  if (status.uiRevision) {
    if (loadedUiRevision === null) loadedUiRevision = status.uiRevision;
    else if (loadedUiRevision !== status.uiRevision && $("#modal-backdrop").hidden) location.reload();
  }
  const desktop = $("#health-desktop");
  desktop.replaceChildren(cell(
    t("health.connection"),
    status.settings.pointsAtRouter ? badge("ok", t("health.connected")) : badge("bad", t("health.notConnected")),
    status.settings.pointsAtRouter ? t("health.connectedHelp") : t("health.notConnectedHelp"),
  ));
  $("#health-requests").replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("health.requests") }), el("span", { class: "v", text: t("health.requestsFmt", Object.fromEntries(Object.entries(status.stats || {}).map(([key, value]) => [key, typeof value === "number" ? value.toLocaleString() : value]))) })]));
  renderHealthProviders();
  if (clientsLoaded) renderClients();
  if (modState.settings) renderModNotice();
  const details = $("#health-details");
  modRedraw(details, [
    versionRow(),
    autoUpdateRow(),
    // Which files answer, and since when: the only way to see that an update actually replaced the router.
    ...(status.runtime ? [cell(t("health.runtime"), null, [el("span", { class: "cell-sub mono", text: status.runtime.router || "?" }), new Date(status.runtime.startedAt).toLocaleString()])] : []),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.routes") }), el("span", { class: "v", text: String(status.routes) })]),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.cli") }), el("span", { class: "v", text: status.cliVersion })]),
  ]);
}

// The update check runs on a click, not with the 5-second refresh: it asks the npm registry. What an
// update means depends on how this copy was installed, so the router's CLI decides and runs it; the
// router restarts on the new version and the served-files check above reloads this page.
let updateState = { busy: false, check: null };
let autoUpdateSaving = false;
function autoUpdateRow() {
  const control = modSwitch("auto-update", status.autoUpdate?.enabled !== false, t("update.auto"), toggleAutoUpdate);
  control.querySelector("input").disabled = autoUpdateSaving || !status.autoUpdate;
  return cell(t("update.auto"), control, t("update.autoHelp"));
}
async function toggleAutoUpdate(enabled) {
  if (autoUpdateSaving) return;
  autoUpdateSaving = true;
  const input = document.querySelector('[data-key="auto-update"]');
  if (input) input.disabled = true;
  try {
    // Do not use latestConfig's stale fallback for an automatic-install preference.
    const next = await api("/api/config");
    next.autoUpdate = enabled;
    await configRequest(next);
    currentConfig = next;
    if (status.autoUpdate) status.autoUpdate.enabled = enabled;
    toast(t("common.saved"));
  } catch (error) {
    toast(t("common.saveFailed"), true, error.message);
  } finally {
    autoUpdateSaving = false;
    await refreshHealth();
    const current = document.querySelector('[data-key="auto-update"]');
    if (current) { current.disabled = !status.autoUpdate; current.checked = status.autoUpdate?.enabled !== false; }
  }
}
function versionRow() {
  const check = updateState.check;
  // The version reads as the row's label; what the update check found sits under it, the action on the right.
  let note = null;
  let button = null;
  if (check && check.newer && check.kind === "checkout") {
    note = t("update.checkout", { latest: check.latest });
  } else {
    const action = check && check.newer;
    const label = updateState.busy ? t("update.checking")
      : check && check.running ? t("update.running")
      : action ? (check.kind === "packaged" ? t("update.download", { latest: check.latest }) : t("update.install", { latest: check.latest }))
      : t("update.check");
    button = el("button", { class: action ? "btn" : "btn secondary", type: "button", text: label });
    button.disabled = updateState.busy || Boolean(check && check.running);
    button.addEventListener("click", () => void (action ? startUpdate() : checkForUpdate()));
    if (check && !check.newer && !updateState.busy) note = t("update.latest");
  }
  const row = cell(el("span", { class: "cell-label", text: `${t("health.version")} ${status.version}` }), button, note);
  row.id = "health-version-row";
  return row;
}
function renderVersionRow() {
  const row = $("#health-version-row");
  if (row) row.replaceWith(versionRow());
}
async function checkForUpdate() {
  updateState = { busy: true, check: updateState.check };
  renderVersionRow();
  try { updateState = { busy: false, check: await api("/api/update") }; }
  catch (error) { updateState = { busy: false, check: null }; toast(t("update.checkFailed"), true, error.message); }
  renderVersionRow();
}
async function startUpdate() {
  const check = updateState.check;
  if (check.kind === "packaged") { window.open("https://github.com/PBJ-2/clauderipple/releases/latest", "_blank", "noreferrer"); return; }
  if (!confirm(t("update.confirm", { latest: check.latest, current: check.current }))) return;
  updateState = { busy: true, check };
  renderVersionRow();
  try {
    await api("/api/update", { method: "POST" });
    updateState = { busy: false, check: { ...check, running: true } };
    toast(t("update.started"));
  } catch (error) {
    updateState = { busy: false, check };
    toast(t("update.failed"), true, error.message);
  }
  renderVersionRow();
}

// ---- Usage panel ---------------------------------------------------------------------
//
// What is left of each subscription plan, from `GET /api/limits`. It is the same body the status
// bar's row reads: one entry per provider, and one account inside it per plan or per key. Only
// subscription providers appear — an API-key provider has a balance, not a window.
//
// One small tile per account, two to a row: the provider's mark, its name, and each window as a
// compact figure ("5H 12%"). The reset times are a tap away — a phone has no hover at all, so a
// tap (or a click) is the only way they are allowed to exist.
//
// A desktop window keeps the panel at the bottom left of the sidebar, where it is visible from
// every page. A phone has no sidebar left (it becomes a tab bar), so the same panel is moved to
// the top of the Status page instead of being duplicated: one element, one place.

const USAGE_REFRESH_MS = 60_000;
const USAGE_OPEN_KEY = "clauderipple_usage_open";
/** The width at which style.css turns the sidebar into a tab bar (see `@media (max-width: 720px)`). */
const USAGE_NARROW = "(max-width: 720px)";

let usageLimits = null;
let usageGeneration = 0;
let usageError = "";
let usageOpen = true;
(function restoreUsageOpen() {
  try {
    const saved = localStorage.getItem(USAGE_OPEN_KEY);
    if (saved === "0") usageOpen = false;
    if (saved === "1") usageOpen = true;
  } catch { /* storage unavailable: stay open */ }
})();

/**
 * Which window a `used_percent` belongs to: `five_hour`, `seven_day`, `month`, `label` (the
 * vendor's own word), or `hours` with the length it is called by. A tile and a key card name the
 * same window, so both read this one classification and only pick their own words for it below.
 */
function usageWindowKind(window) {
  const minutes = typeof window.window_minutes === "number" ? window.window_minutes : 0;
  if (window.kind === "five_hour" || minutes === 5 * 60) return { kind: "five_hour" };
  if (window.kind === "seven_day" || minutes === 7 * 24 * 60) return { kind: "seven_day" };
  // About a month: OpenCode Go's third window.
  if (minutes >= 28 * 24 * 60) return { kind: "month" };
  if (window.label) return { kind: "label", label: String(window.label) };
  if (minutes > 0) return { kind: "hours", hours: Math.max(1, Math.round(minutes / 60)) };
  return { kind: "other" };
}

/** The tile's short name for that window: 5H, 7D, M. */
function usageWindowName(window) {
  const kind = usageWindowKind(window);
  if (kind.kind === "five_hour") return t("usage.window5h");
  if (kind.kind === "seven_day") return t("usage.window7d");
  if (kind.kind === "month") return t("usage.windowMonth");
  if (kind.kind === "label") return kind.label;
  if (kind.kind === "hours") return t("usage.windowHours", { hours: kind.hours });
  return t("usage.windowOther");
}

/** The long name a key card uses for the same window: 5시간, 주간, 월간. */
function usageWindowLongName(window) {
  const kind = usageWindowKind(window);
  if (kind.kind === "five_hour") return t("quota.window5h");
  if (kind.kind === "seven_day") return t("quota.windowWeek");
  if (kind.kind === "month") return t("keys.windowMonth");
  if (kind.kind === "label") return kind.label;
  if (kind.kind === "hours") return t("quota.windowHours", { hours: kind.hours });
  return t("usage.windowOther");
}

/**
 * How long until the window resets, in the shortest reading that stays honest: "59m", "3h 35m",
 * "2d 7h". Two units at most, so the line beside the percent never grows.
 */
function usageResetText(window) {
  if (typeof window.reset_at !== "number") return "";
  const left = Math.round(window.reset_at * 1000 - Date.now());
  if (left <= 0) return t("usage.resetting");
  const minutes = Math.floor(left / 60_000);
  if (minutes >= 24 * 60) return t("usage.daysHours", { d: Math.floor(minutes / (24 * 60)), h: Math.floor((minutes % (24 * 60)) / 60) });
  if (minutes >= 60) return t("usage.hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 });
  return t("usage.minutes", { m: Math.max(1, minutes) });
}

/** Whole days until an epoch-seconds moment: "12d". The M row reads only this much. */
function usageDaysText(epoch) {
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) return "";
  const left = Math.round(epoch * 1000 - Date.now());
  if (left <= 0) return t("usage.daysShort", { days: 0 });
  return t("usage.daysShort", { days: Math.max(1, Math.ceil(left / 86_400_000)) });
}

/** Percent as it is written on a tile; one decimal only where the whole number would hide a rise. */
function usagePercentText(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return value >= 10 || Number.isInteger(value) ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

/** How a percent is coloured: quiet up to 80, a warning to 99, a full window red. */
function usageSeverity(percent) {
  const value = Number(percent) || 0;
  return value >= 100 ? " full" : value >= 80 ? " high" : "";
}

/** "GPT 1" — the account's own name where the router gives one, else its provider and position. */
function usageAccountName(provider, account, index, count) {
  const own = account.label || (account.title && String(account.title));
  // A named account is called by its name; the position is only how an unnamed one is told apart.
  if (own) return own;
  return count <= 1 ? usageBaseName(provider) : `${usageBaseName(provider)} ${index + 1}`;
}

// A prepaid-credit vendor writes its own name with capitals; the router only knows its config key.
// Replace that lowercase default, never a name the user chose.
const USAGE_CREDIT_NAMES = new Map([["openrouter", "OpenRouter"], ["sail", "sail"]]);

/** The provider's short word: "Claude", "GPT", "Go", "Gemini", "Grok". */
function usageBaseName(provider) {
  if (provider.type === "opencode-go") return t("usage.goName");
  const own = provider.title || provider.provider;
  const lower = String(own).toLowerCase();
  const proper = provider.type === "credit" && own === lower ? USAGE_CREDIT_NAMES.get(lower) : undefined;
  return proper || own;
}

/** The tile's square mark: the short name's first letters, like an app icon ("Cl", "GP", "Go"). */
function usageMarkText(provider) {
  const letters = String(usageBaseName(provider) || "").replace(/[^A-Za-z0-9]/g, "");
  return letters.slice(0, 2) || "•";
}

/**
 * One line of the tile: "5H 42% 59m" — label, percent and time left, always shown. The three are
 * columns (see style.css), so the numbers line up down a tile and between accounts.
 */
function usageRow(label, percent, percentClass, time, kind) {
  return el("span", { class: "usage-tile-row" }, [
    el("span", { class: "usage-tile-window", text: label }),
    el("span", { class: `usage-tile-percent${percentClass || ""}`, text: percent }),
    el("span", { class: "usage-tile-reset", ...(kind ? { "data-window": kind } : {}), text: time }),
  ]);
}

/**
 * A quota window as its line. The M row counts whole days — the renewal date when the account has
 * one, else the window's own reset — and the shorter windows keep the h/m reading.
 */
function usageFigure(window, account) {
  const kind = usageWindowKind(window).kind;
  const percent = usagePercentText(window.used_percent);
  const time = kind === "month"
    ? usageDaysText(typeof account.renews_at === "number" ? account.renews_at : window.reset_at)
    : usageResetText(window);
  return usageRow(usageWindowName(window), percent, usageSeverity(window.used_percent), time, kind);
}

/** A credit balance as the tile writes it: "$738", "$73.9", "$3.95". Cents only where they matter. */
function usageUsd(remaining) {
  const value = Number(remaining) || 0;
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

/** Whole days left as the credit tile says them: "12d", the same reading the M row uses. */
function usageCreditDays(days) {
  return t("usage.daysShort", { days: Math.max(0, Math.floor(Number(days))) });
}

/**
 * The head of every tile: a small mark, then the name. A tile is narrow, so the name is allowed to
 * shorten itself but never to wrap; the whole name stays reachable as the button's title.
 */
function usageTileHead(name, provider) {
  return el("span", { class: "usage-tile-head" }, [
    el("span", { class: "usage-tile-mark", "aria-hidden": "true", text: usageMarkText(provider) }),
    el("span", { class: "usage-tile-name", text: name }),
  ]);
}

/** The account's quota rows, and the M row when the vendor renews a subscription instead of metering it. */
function usageAccountFigures(account, windows) {
  const monthWindow = windows.find((window) => usageWindowKind(window).kind === "month");
  const rows = windows.map((window) => usageFigure(window, account));
  if (!monthWindow && typeof account.renews_at === "number") {
    // GPT and Claude have no monthly quota: the M row is the renewal, with no percent to show.
    rows.push(usageRow(t("usage.windowMonth"), "—", "", usageDaysText(account.renews_at), "month"));
  }
  return rows;
}

/** A credit balance as one line: "잔액 $738 12d", the days column left empty when they are unknown. */
function usageCreditFigure(credit) {
  const days = typeof credit.days_remaining === "number" && Number.isFinite(credit.days_remaining)
    ? usageCreditDays(credit.days_remaining)
    : "";
  return usageRow(t("usage.creditBalance"), usageUsd(credit.remaining_usd), credit.low ? " high" : "", days, "credit");
}

function usageAccountRows(account) {
  const windows = Array.isArray(account.windows) ? account.windows.filter((window) => window && typeof window.used_percent === "number") : [];
  if (windows.length) return usageAccountFigures(account, windows);
  if (account.credit && typeof account.credit.remaining_usd === "number") return [usageCreditFigure(account.credit)];
  // An account with neither windows nor a balance still counts toward the (n/m) on the tile.
  return [];
}

/** Which account a provider's tile is about when it has several: the one in use, else the first. */
const usageInUse = new Map();
const usageExpanded = new Set();

/**
 * Accounts whose rows are worth drawing: any provider with several accounts opens them, prepaid
 * credit included — a credit vendor with two keys shows the key in use and the rest behind a tap.
 */
function usageExpandable(provider, accounts) {
  return accounts.length > 1;
}

function usageTile(provider, accounts) {
  const inUse = usageInUse.has(provider.provider) ? usageInUse.get(provider.provider) : 0;
  const index = inUse >= 0 && inUse < accounts.length ? inUse : 0;
  const account = accounts[index];
  const base = usageBaseName(provider);
  const name = usageExpandable(provider, accounts) ? `${base} (${index + 1}/${accounts.length})` : base;
  const open = usageExpanded.has(provider.provider);
  const rows = [];
  for (const row of usageAccountRows(account)) rows.push(row);
  if (open) {
    // The accounts the tile does not speak for, each under its own name so the figure has an owner.
    accounts.forEach((other, at) => {
      if (at === index) return;
      const otherRows = usageAccountRows(other);
      if (!otherRows.length) return;
      rows.push(el("span", { class: "usage-tile-account", text: usageAccountName(provider, other, at, accounts.length) }));
      for (const row of otherRows) rows.push(row);
    });
  }
  const body = el("span", { class: "usage-tile-figures" }, rows);
  const kindClass = provider.type === "credit" ? " credit" : "";
  if (!usageExpandable(provider, accounts)) {
    return el("span", { class: `usage-tile${kindClass}`, title: name }, [usageTileHead(name, provider), body]);
  }
  const tile = el("button", { class: `usage-tile expandable${kindClass}${open ? " open" : ""}`, type: "button", title: name, "aria-expanded": String(open), "aria-label": name }, [
    usageTileHead(name, provider),
    body,
  ]);
  tile.addEventListener("click", () => {
    if (usageExpanded.has(provider.provider)) usageExpanded.delete(provider.provider); else usageExpanded.add(provider.provider);
    renderUsage();
  });
  return tile;
}

/**
 * One tile per provider, two to a row; several accounts share the tile and open on a tap.
 * Subscription plans (everything that is not prepaid credit) come first, then the credit
 * balances, each group in config order — the plans are what the user watches, the balance is
 * a footnote. Config order alone would put them wherever their provider entry happens to sit.
 */
function usageTiles(providers) {
  const drawable = providers.filter((provider) => Array.isArray(provider.accounts) && provider.accounts.length);
  const plans = drawable.filter((provider) => provider.type !== "credit");
  const credits = drawable.filter((provider) => provider.type === "credit");
  return [...plans, ...credits].map((provider) => usageTile(provider, provider.accounts));
}

/**
 * Ask the router which account each multi-account provider is using. `/api/limits` numbers accounts
 * in the same order as these lists, but only counts the ones it has quota for, so the answer is an
 * index to look up, not a promise; a miss falls back to the first account.
 */
async function usageKeyAccounts(name, type) {
  // Every key-based provider (subscription or prepaid credit) answers on the same endpoint; the old
  // OpenCode Go one is still there for a router that predates it.
  try { return await api(`/api/provider-keys?provider=${encodeURIComponent(name)}`); }
  catch (error) {
    // Only a router too old to know the new path (404) is worth asking the old one; any other
    // failure is the answer, and asking twice would only hide it.
    if (type === "opencode-go" && error.status === 404) return api(`/api/opencode-accounts?provider=${encodeURIComponent(name)}`);
    throw error;
  }
}

async function resolveUsageInUse(providers) {
  let changed = false;
  for (const provider of providers) {
    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    if (!usageExpandable(provider, accounts)) continue;
    const name = provider.provider;
    try {
      let at = -1;
      if (provider.type === "chatgpt") {
        const body = await api(`/api/chatgpt-accounts?provider=${encodeURIComponent(name)}`);
        const list = (Array.isArray(body.accounts) ? body.accounts : []).filter((a) => a.state !== "paused" && a.state !== "needs-login");
        at = list.findIndex((a) => a.active === true);
      } else if (provider.type !== "anthropic" && provider.type !== "google" && provider.type !== "grok") {
        const body = await usageKeyAccounts(name, provider.type);
        const list = Array.isArray(body.accounts) ? body.accounts : [];
        at = list.findIndex((a) => a.state === "in-use");
      }
      // That list's position is the account number the router gives a limits row, and a row for a
      // key with no readable windows is left out of `/api/limits`, so match by number.
      const limitIndex = at >= 0 ? accounts.findIndex((a) => a.account === at) : -1;
      const next = limitIndex >= 0 ? limitIndex : 0;
      if (usageInUse.get(name) !== next) { usageInUse.set(name, next); changed = true; }
    } catch { /* the tile stays on its fallback account */ }
  }
  if (changed) renderUsage();
}

function renderUsage() {
  const box = $("#usage-cards");
  const empty = $("#usage-empty");
  if (!box || !empty) return;
  const providers = (usageLimits && Array.isArray(usageLimits.providers)) ? usageLimits.providers : [];
  const tiles = usageTiles(providers);
  box.replaceChildren(...tiles);
  box.hidden = tiles.length === 0;
  empty.hidden = tiles.length !== 0;
  // An unreachable router is a quiet note, not a tile: the panel keeps its last good numbers.
  empty.textContent = tiles.length === 0 ? (usageError || t("usage.empty")) : "";
}

async function refreshUsage() {
  const generation = ++usageGeneration;
  try {
    const body = await api("/api/limits");
    if (generation !== usageGeneration) return;
    usageLimits = body;
    usageError = "";
  } catch (error) {
    if (generation !== usageGeneration) return;
    // Keep the last good numbers; say why only when there are none to keep. An HTTP answer is its
    // own reason (a 404 from an older router, a 500), so it is named rather than swallowed.
    usageError = error.status ? t("usage.unreachableStatus", { status: error.status }) : t("usage.unreachable");
  }
  renderUsage();
  if (generation === usageGeneration && usageLimits) void resolveUsageInUse(usageLimits.providers || []);
}

/** Open or closed, remembered: someone who folded the panel away does not want it back each visit. */
function setUsageOpen(open) {
  usageOpen = open;
  const panel = $("#usage-panel");
  const toggle = $("#usage-toggle");
  if (panel) panel.classList.toggle("collapsed", !open);
  if (toggle) toggle.setAttribute("aria-expanded", String(open));
  try { localStorage.setItem(USAGE_OPEN_KEY, open ? "1" : "0"); } catch { /* unavailable */ }
}

/** A phone moves the one panel into the Status page; a wider window puts it back in the sidebar. */
function placeUsagePanel() {
  const panel = $("#usage-panel");
  const slot = $("#usage-slot");
  const phone = $("#usage-slot-phone");
  if (!panel || !slot || !phone) return;
  const narrow = window.matchMedia(USAGE_NARROW).matches;
  const target = narrow ? phone : slot;
  if (panel.parentElement !== target) target.appendChild(panel);
  panel.classList.toggle("in-phone-slot", narrow);
}

$("#usage-toggle") && $("#usage-toggle").addEventListener("click", () => setUsageOpen(!usageOpen));
(function setupUsagePanel() {
  placeUsagePanel();
  setUsageOpen(usageOpen);
  window.matchMedia(USAGE_NARROW).addEventListener("change", () => { placeUsagePanel(); });
  void refreshUsage();
  setInterval(() => {
    // Nothing on screen to update while a page is hidden; the next visit refreshes anyway.
    if (document.visibilityState === "hidden") return;
    void refreshUsage();
  }, USAGE_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshUsage();
  });
})();

// ---- Inside the app: the connection card, and pages while the router is down -------------
// The app can do what this page cannot once the router is down: ask the CLI what is wrong
// (doctor), repair it, switch Claude to its default connection and back, reopen Claude. The card at
// the top of Status draws that, calm while all is well and plain about what to press when not. The
// other pages say where to go instead of failing. None of it exists in a browser.

function offline() { return Boolean(APP) && routerDown; }
function inDirectMode() { return Boolean(shellState && shellState.doctor && shellState.doctor.mode === "direct"); }

function setRouterDown(down) {
  if (routerDown === down) return;
  routerDown = down;
  if (!down) {
    // Back: what failed or was skipped while it was down loads now.
    slotsLoaded = false;
    providersLoaded = false;
    clientsLoaded = false;
    showView((location.hash || "#health").slice(1) || "health");
  } else applyOffline();
  renderConnection();
}

/** Every page but Status shows a short note (and the way to Status) instead of its contents. */
function applyOffline() {
  const off = offline();
  const direct = inDirectMode();
  for (const view of $all(".view")) {
    if (view.id === "view-health") {
      view.classList.toggle("router-off", off);
      continue;
    }
    view.classList.toggle("offline", off);
    let box = $(".offline-state", view);
    if (!off) {
      if (box) box.remove();
      continue;
    }
    if (!box) {
      box = el("div", { class: "offline-state", role: "status" });
      const header = $(".page-header", view);
      view.insertBefore(box, header ? header.nextSibling : view.firstChild);
    }
    box.replaceChildren(
      el("div", { class: `offline-icon${direct ? " direct" : ""}` }, [svgIcon("0 0 20 20", direct ? CONN_ICONS.direct : ["M3 3l14 14", "M6.2 15.5h8.1c.4 0 .8-.1 1.2-.2", "M17.4 12.6a3.3 3.3 0 0 0-2.7-3.7 4.8 4.8 0 0 0-6.8-3.5", "M5.6 8.3a3.7 3.7 0 0 0 .6 7.2"])]),
      el("h2", { text: t(direct ? "conn.offlineDirectTitle" : "conn.offlineTitle") }),
      el("p", { text: t(direct ? "conn.offlineDirectBody" : "conn.offlineBody") }),
      el("button", { class: "btn", type: "button", text: t("conn.goStatus"), onclick: () => showView("health") }),
    );
  }
}

const CONN_ICONS = {
  ok: ["M5.5 10.4l3 3 6-6.6"],
  bad: ["M10 5.6v5.2", "M10 14.3v.1"],
  warn: ["M10 5.6v5.2", "M10 14.3v.1"],
  direct: ["M3.8 10h12", "M12.2 6.2L16 10l-3.8 3.8"],
  checking: ["M10 3.8a6.2 6.2 0 1 1-6.2 6.2"],
};
// What doctor's codes mean to someone who only wants Claude to answer. The cause comes before the
// symptom: a startup entry gone missing is why the router is down.
const CONN_REASONS = [
  ["not-installed", "conn.why.notInstalled"],
  ["supervisor-missing", "conn.why.supervisorMissing"],
  ["supervisor-program-missing", "conn.why.programMissing"],
  ["supervisor-other-install", "conn.why.otherInstall"],
  ["supervisor-not-running", "conn.why.stopped"],
  ["router-down", "conn.why.stopped"],
  ["router-version-mismatch", "conn.why.version"],
  ["cli-port-mismatch", "conn.why.oldSetting"],
  ["desktop-port-mismatch", "conn.why.oldSetting"],
  ["cli-foreign-proxy", "conn.why.cliOther"],
  ["desktop-foreign-proxy", "conn.why.desktopOther"],
];
function connReason(doctor) {
  const problems = (doctor && doctor.problems) || [];
  for (const [code, key] of CONN_REASONS) if (problems.some((problem) => problem.code === code)) return t(key);
  const other = problems.find((problem) => problem.code !== "mixed-mode" && problem.message);
  return other ? other.message : null;
}
function connRoute(proxy) { return t(proxy === "ripple" ? "conn.routeRipple" : proxy === "none" ? "conn.routeDirect" : "conn.routeOther"); }

/** Whether the router answers, by this page's own 5-second check first, then the app's. */
function connAnswering(s) {
  if (routerDown) return false;
  if (status) return true;
  if (s && typeof s.routerAnswering === "boolean") return s.routerAnswering;
  return null;
}

/** Which state the card is in, what it says, and which button is the obvious one. */
function connectionModel(s) {
  const d = s && s.doctor;
  const answering = connAnswering(s);
  const lastResult = s && s.result;
  if (d && d.mode === "direct") return { kind: "direct", title: t("conn.directTitle"), lead: t("conn.directBody"), primary: "direct-off", secondary: null };
  if (answering === false) {
    // A repair that did not work leaves the switch as the way to a working Claude now.
    const repairFailed = Boolean(lastResult && lastResult.action === "repair" && !lastResult.ok);
    const reason = d ? connReason(d) || t("conn.why.stopped") : s && s.doctorFailed ? t("conn.why.checkFailed") : null;
    return { kind: "bad", title: t("conn.downTitle"), lead: t("conn.downLead"), reason, primary: repairFailed ? "direct-on" : "repair", secondary: repairFailed ? "repair" : "direct-on" };
  }
  if (!d && !(s && s.doctorFailed) && answering === null) return { kind: "checking", title: t("conn.checking"), lead: "", primary: null, secondary: null };
  if (d && d.mode === "mixed") return { kind: "warn", title: t("conn.mixedTitle"), lead: t("conn.mixedBody", { desktop: connRoute(d.desktop && d.desktop.proxy), cli: connRoute(d.cli && d.cli.proxy) }), primary: "direct-off", secondary: "direct-on" };
  const reason = d && connReason(d);
  if (reason) return { kind: "warn", title: t("conn.warnTitle"), lead: reason, primary: "repair", secondary: "direct-on" };
  return { kind: "ok", title: t("conn.okTitle"), lead: s && s.doctorFailed ? t("conn.why.checkFailed") : t("conn.okBody"), primary: null, secondary: "direct-on" };
}

const CONN_ACTIONS = {
  "repair": { label: "conn.repair", hint: "conn.repairHint", run: () => APP.repair() },
  "direct-on": { label: "conn.directOn", hint: "conn.directOnHint", run: () => APP.directOn() },
  "direct-off": { label: "conn.directOff", hint: "conn.directOffHint", run: () => APP.directOff() },
  "restart-claude": { label: "conn.restart", hint: null, run: () => APP.restartClaude() },
};
const CONN_BUSY = { "repair": "conn.busy.repair", "direct-on": "conn.busy.directOn", "direct-off": "conn.busy.directOff", "restart-claude": "conn.busy.restart", "checking": "conn.busy.checking" };
/** A result older than this is history, not news. */
const CONN_RESULT_MS = 10 * 60 * 1000;

async function connRun(run) {
  try {
    const next = await run();
    if (next) shellState = next;
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
  renderConnection();
  void refreshHealth();
}
function connButton(id, cls) {
  const action = CONN_ACTIONS[id];
  const button = el("button", { class: cls, type: "button", text: t(action.label), onclick: () => void connRun(action.run) });
  button.disabled = Boolean(shellState && shellState.busy);
  return button;
}
function connResultText(r) {
  if (r.timedOut) return t("conn.res.timeout");
  const keys = {
    "repair": r.ok ? "conn.res.repairOk" : "conn.res.repairFail",
    "direct-on": r.ok ? "conn.res.directOnOk" : "conn.res.fail",
    "direct-off": r.ok ? "conn.res.directOffOk" : "conn.res.fail",
    "restart-claude": r.ok ? "conn.res.restartOk" : "conn.res.restartFail",
  };
  return t(keys[r.action] || "conn.res.fail");
}

/** The running action, the last result and the "reopen Claude" step: the same in both card sizes. */
function connNotes(s) {
  const notes = [];
  if (s && s.busy) notes.push(el("div", { class: "conn-note busy", role: "status" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: t(CONN_BUSY[s.busy] || "conn.busy.checking") })]));
  const r = s && s.result;
  if (r && !s.busy && (!r.at || Date.now() - r.at < CONN_RESULT_MS)) {
    const ok = r.ok && !r.timedOut;
    notes.push(el("div", { class: `conn-note ${ok ? "good" : "bad"}`, role: "status" }, [
      el("div", { class: "conn-note-line" }, [svgIcon("0 0 20 20", ok ? CONN_ICONS.ok : CONN_ICONS.bad, "conn-note-icon"), el("span", { text: connResultText(r) })]),
      r.details && r.details.length ? el("details", { class: "conn-fold" }, [el("summary", { text: t("conn.details") }), el("pre", { text: r.details.join("\n") })]) : null,
    ]));
  }
  if (s && s.restartClaude) {
    notes.push(el("div", { class: "conn-note restart" }, [
      el("div", { class: "conn-note-text" }, [el("strong", { text: t("conn.restartTitle") }), el("span", { text: t("conn.restartBody") })]),
      connButton("restart-claude", "btn"),
    ]));
  }
  return notes;
}

let connDetailsOpen = false;
let connLogLines = null;
function connDetails(s) {
  const d = (s && s.doctor) || {};
  const router = d.router || {};
  const supervisor = d.supervisor || {};
  const row = (k, v) => el("div", { class: "row" }, [el("span", { class: "k", text: k }), el("span", { class: "v mono", text: v })]);
  const rows = [
    row(t("conn.d.router"), `${router.responding ? "responding" : "not responding"}${router.version ? ` · ${router.version}` : ""}${router.url ? ` · ${router.url}` : ""}`),
    row(t("conn.d.supervisor"), `${supervisor.registered ? "registered" : "not registered"}${supervisor.state ? ` · ${supervisor.state}` : ""}${supervisor.program ? ` · ${supervisor.program}` : ""}`),
    row(t("conn.d.desktop"), `${(d.desktop && d.desktop.proxy) || "?"}${d.desktop && d.desktop.url ? ` · ${d.desktop.url}` : ""}`),
    row(t("conn.d.cli"), `${(d.cli && d.cli.proxy) || "?"}${d.cli && d.cli.url ? ` · ${d.cli.url}` : ""}`),
    ...((d.problems || []).map((problem) => row(problem.code || "?", problem.message || ""))),
  ];
  const log = el("pre", { class: "conn-log", text: connLogLines === null ? "…" : connLogLines.length ? connLogLines.join("\n") : t("conn.noLog") });
  const fold = el("details", { class: "conn-details" }, [
    el("summary", { text: t("conn.details") }),
    el("div", { class: "group conn-detail-rows" }, rows),
    el("div", { class: "conn-log-head" }, [el("span", { class: "section-title", text: t("conn.recentLog") }), el("button", { class: "btn secondary compact", type: "button", text: t("conn.openLogs"), onclick: () => void APP.openLogs() })]),
    log,
  ]);
  fold.open = connDetailsOpen;
  fold.addEventListener("toggle", () => {
    connDetailsOpen = fold.open;
    if (fold.open) void APP.recentLog().then((lines) => { connLogLines = lines || []; log.textContent = connLogLines.length ? connLogLines.join("\n") : t("conn.noLog"); log.scrollTop = log.scrollHeight; });
  });
  return fold;
}

function connLoginOffer(s) {
  if (!s || s.loginItem !== false) return null;
  return el("div", { class: "conn-login" }, [
    el("span", { text: t("conn.loginOffer") }),
    el("button", { class: "btn secondary compact", type: "button", text: t("conn.loginOn"), onclick: () => void connRun(() => APP.enableLoginItem()) }),
  ]);
}

function renderConnection() {
  const host = $("#health-connection");
  if (!APP || !host) return;
  host.hidden = false;
  $("#health-desktop-section").hidden = true;
  const s = shellState;
  const m = connectionModel(s);
  const calm = m.kind === "ok" || m.kind === "checking";
  // After a switch, reopening Claude is the one thing left to do; the rest steps back.
  const demote = Boolean(s && s.restartClaude);
  host.className = `conn conn-${m.kind}${calm ? " calm" : " loud"}`;
  const refresh = el("button", { class: "link-btn", type: "button", text: t("conn.refresh"), onclick: () => void connRun(() => APP.refresh()) });
  refresh.disabled = Boolean(s && s.busy);
  if (calm) {
    host.replaceChildren(el("div", { class: "group" }, [
      el("div", { class: "cell conn-calm-row" }, [
        el("span", { class: "conn-dot", "aria-hidden": "true" }),
        el("div", { class: "cell-text" }, [el("span", { class: "cell-label strong", text: m.title }), m.lead ? el("span", { class: "cell-sub", text: m.lead }) : null]),
        m.secondary ? el("div", { class: "cell-value" }, [connButton(m.secondary, "btn secondary compact")]) : null,
      ]),
      ...connNotes(s).map((note) => el("div", { class: "cell-note conn-calm-note" }, [note])),
      connLoginOffer(s) ? el("div", { class: "cell-note conn-calm-note" }, [connLoginOffer(s)]) : null,
    ]));
    return;
  }
  const actions = [m.primary, m.secondary].filter(Boolean).map((id, index) => el("div", { class: "conn-action" }, [
    connButton(id, `btn large${index === 0 && !demote ? "" : " secondary"}`),
    CONN_ACTIONS[id].hint ? el("p", { class: "hint", text: t(CONN_ACTIONS[id].hint) }) : null,
  ]));
  host.replaceChildren(el("div", { class: "conn-card" }, [
    el("div", { class: "conn-hero" }, [
      el("div", { class: "conn-icon" }, [svgIcon("0 0 20 20", CONN_ICONS[m.kind] || CONN_ICONS.bad)]),
      el("div", { class: "conn-hero-text" }, [
        el("h2", { class: "conn-title", text: m.title }),
        m.lead ? el("p", { class: "conn-lead", text: m.lead }) : null,
        m.reason ? el("p", { class: "conn-reason", text: m.reason }) : null,
      ]),
    ]),
    ...connNotes(s),
    actions.length ? el("div", { class: "conn-actions" }, actions) : null,
    connLoginOffer(s),
    el("div", { class: "conn-foot" }, [connDetails(s), refresh]),
  ]));
}

if (APP) {
  APP.onState((next) => { shellState = next; renderConnection(); applyOffline(); });
  void APP.state().then((next) => { shellState = next; renderConnection(); applyOffline(); });
}

function quotaLine(name) {
  const quota = status && status.chatgpt && status.chatgpt.quota && status.chatgpt.quota[name];
  const primary = quota && quota.rate_limits && quota.rate_limits.primary;
  if (!primary) return null;
  // The usage figure is what anyone acts on. The reset countdown was a second number beside it
  // that nobody does anything with, so it is left out.
  return t("health.quota", { percent: primary.used_percent, reset: "" });
}
/**
 * One line a person can read. Vendors answer with a JSON body and sometimes an escaped one inside
 * it; the useful part is the status and the vendor's own message, not the envelope around them.
 * The full text stays on the element's title.
 */
function shortError(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const status = raw.match(/\b(\d{3})\b/);
  let message = "";
  try {
    const json = raw.slice(raw.indexOf("{"));
    const parsed = JSON.parse(json);
    const err = parsed.error || parsed;
    message = String(err.message || err.error || "").trim();
  } catch { /* not JSON, or truncated: fall back to the raw head */ }
  if (!message) message = raw.replace(/\s+/g, " ").slice(0, 120);
  const head = status ? `HTTP ${status[1]}` : "";
  const line = [head, message].filter(Boolean).join(" · ");
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** How long a probe result speaks for the provider before the live reading takes over. */
const PROBE_TTL_MS = 90_000;
function probeIsStale(state) { return !state.pending && typeof state.at === "number" && Date.now() - state.at > PROBE_TTL_MS; }
function stateFor(name) { return probeStates.get(name); }
function chatgptLoginButton(onChange) {
  const button = el("button", { class: "btn secondary", type: "button", text: t("providers.chatgptLogin") });
  button.disabled = chatgptLoginBusy;
  button.addEventListener("click", () => void startChatgptLogin(onChange));
  return button;
}
/**
 * Runs the browser sign-in, which adds an account (or signs one in again). Finished is the sign-in
 * process ending, not "signed in": with an account already there, "signed in" is true from the start.
 */
async function startChatgptLogin(onChange, adding) {
  if (chatgptLoginBusy) return;
  chatgptLoginBusy = true;
  chatgptLoginMessage = adding ? t("providers.chatgptAddWaiting") : t("providers.chatgptLoginWaiting");
  onChange && onChange();
  try {
    await api("/api/chatgpt-login", { method: "POST" });
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const login = await api("/api/chatgpt-login");
      if (login.running === false && login.ok === true) {
        toast(adding ? t("providers.chatgptAdded") : t("providers.chatgptLoginDone"));
        await refreshHealth();
        return;
      }
      if (login.running === false && login.ok === false) {
        toast(t("common.actionFailed"), true, login.output);
        return;
      }
    }
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    chatgptLoginBusy = false;
    chatgptLoginMessage = "";
    onChange && onChange();
  }
}
/**
 * Which of a provider's credentials are resting, and until when. Absent for a provider with one
 * credential: a row that can only ever say "ready" is noise. Ids and labels only — never a key.
 */
function credentialLine(name) {
  const pool = (status && status.credentials && status.credentials[name]) || [];
  if (!pool.length) return null;
  const parts = pool.map((c) => {
    const who = c.label || c.id;
    if (c.state === "paused") return `${who}: ${t("providers.chatgptPaused")}`;
    if (c.state === "quarantined") return `${who}: ${t("pool.quarantined")}`;
    if (c.state === "cooling") return `${who}: ${t("pool.cooling", { seconds: c.cooldownSeconds ?? 0 })}`;
    return `${who}: ${t("pool.ready")}`;
  });
  const resting = pool.filter((c) => c.state !== "ready").length;
  return el("div", { class: `small ${resting ? "bad-text" : ""}`.trim(), text: parts.join(" · ") });
}

/**
 * One verdict on a provider's connection, which the badge and the detail heading both show. They
 * used to decide separately: the heading kept a failure from a restart long after the badge had
 * healed, and both read a check still running as "disconnected" (Gemini, 2026-10-02).
 */
function providerConnection(name) {
  const live = status && status.providers && status.providers[name];
  // A successful TCP probe (or an older model probe) cannot undo a real billing refusal.
  if (live && live.exhaustion) return { level: "warn", text: `${live.exhaustion.reason.replace(/_/g, " ")} · ${new Date(live.exhaustion.until).toLocaleTimeString()}` };
  // Reaching the host is not the same as being able to use it. A ChatGPT provider with no
  // credentials would otherwise read "Connected" and send the user off believing it works.
  if (live && live.needsLogin) return { level: "warn", text: t("providerStatus.loginNeeded") };
  if (live && live.needsVerification) return { level: "warn", text: t("providers.googleVerifyNeeded") };
  const state = stateFor(name);
  if (state && state.pending) return { level: "warn", text: t("providerStatus.checking") };
  // A probe is the better evidence — it actually called the provider — but only while it is fresh.
  // One caught mid-restart used to sit there in red for the rest of the session, while the poll
  // every five seconds said the provider was fine and a fresh probe agreed. After PROBE_TTL_MS the
  // live reading takes over, so a stale failure heals itself instead of needing a manual re-check.
  if (state && !probeIsStale(state)) {
    if (state.ok) return { level: "ok", text: t("providerStatus.connected") };
    // The key was accepted and the plan refused: saying "check your key" sends the operator to the
    // one thing that is not wrong. Measured 2026-09-22 against OpenCode's free-tier 403.
    if (state.auth === "not-entitled") return { level: "bad", text: t("providerStatus.notEntitled") };
    if (state.auth === "bad-key") return { level: "bad", text: t("providerStatus.keyNeeded") };
    return { level: "bad", text: t("providerStatus.disconnected") };
  }
  if (live) return live.reachable ? { level: "ok", text: t("providerStatus.connected") } : { level: "bad", text: t("providerStatus.disconnected") };
  if (state) return { level: "bad", text: t("providerStatus.disconnected") };
  return { level: "warn", text: t("providerStatus.checking") };
}
function providerState(name) {
  const verdict = providerConnection(name);
  return badge(verdict.level, verdict.text);
}
function renderHealthProviders() {
  const box = $("#health-providers");
  const providers = Object.entries((currentConfig && currentConfig.providers) || (status && status.providers) || {});
  if (!providers.length) {
    box.replaceChildren(hint(t("health.noProviders")));
    return;
  }
  box.replaceChildren(...providers.map(([name, provider]) => {
    const live = status && status.providers && status.providers[name];
    const lines = [];
    const quota = quotaLine(name);
    if (quota) lines.push(el("span", { class: "cell-sub", text: quota }));
    // Claude subscription accounts, one line each: the current login and every account added here.
    // Before the config has loaded the rows come from the status, which names the sign-in source
    // rather than the auth mode.
    if (provider.type === "anthropic" && (provider.auth === "claude-code" || (live && live.authSource))) {
      const usage = ((status && status.claude && status.claude.accounts) || [])
        .map((account) => ({ account, text: chatgptQuotaText(account.quota) }))
        .filter(({ text }) => text)
        .map(({ account, text }) => el("div", { text: `${claudeAccountLabel(account)} · ${text}` }));
      if (usage.length) lines.push(el("div", { class: "cell-sub account-usage" }, usage));
    }
    const pool = credentialLine(name);
    if (pool) lines.push(pool);
    if (live && live.needsLogin && provider.type === "chatgpt") {
      lines.push(el("div", { class: "cell-actions" }, [
        chatgptLoginButton(() => renderHealthProviders()),
        chatgptLoginMessage ? el("span", { class: "small", text: chatgptLoginMessage }) : null,
      ]));
    }
    // The row opens the provider's own page; a button inside it keeps its own click.
    const row = cell(el("span", { class: "cell-label", text: name }), [providerState(name, provider), chevronIcon()], lines, "provider-status link");
    row.tabIndex = 0;
    const open = (event) => { if (!event.target.closest("button, a")) openProvider(name, provider); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target === row) open(event); });
    return row;
  }));
}

let statusModBusy = false;
let codexBusy = false;
function renderClients() {
  if (!currentConfig || !status) return;
  const picker = status.picker || { enabled: false, last: null };
  const last = picker.last || null;
  const names = status.pickerModels || [];
  // The switch rows are static markup, so a five-second refresh never takes keyboard focus off one;
  // only the rows after the switch are rebuilt.
  const pickerGroup = $("#client-picker-rows");
  while (pickerGroup.children.length > 1) pickerGroup.lastElementChild.remove();
  if (picker.enabled) {
    pickerGroup.append(
      el("div", { class: "cell-note", text: t("picker.models", { count: names.length, names: names.join(", ") || "—" }) }),
      el("div", { class: "cell-note", text: last && last.at ? t("picker.lastAt", { at: new Date(last.at).toLocaleString() }) : t("picker.never") }),
    );
  }
  const pickerSwitch = $("#client-picker-toggle");
  pickerSwitch.checked = Boolean(picker.enabled);
  pickerSwitch.disabled = pickerBusy;
  // Turning it on asks first (the OS trust prompt follows); a "no" puts the switch back.
  pickerSwitch.onchange = () => {
    if (!picker.enabled && !confirm(t("picker.confirmOn"))) { pickerSwitch.checked = false; return; }
    pickerSwitch.disabled = true;
    void togglePicker(!picker.enabled, true);
  };
  renderClientPickerModels(picker.enabled);
  renderModelSlots();
  const modEnabled = Boolean(status.statusMod);
  const modSwitch = $("#client-status-mod-toggle");
  modSwitch.checked = modEnabled;
  modSwitch.disabled = statusModBusy;
  modSwitch.onchange = () => { modSwitch.disabled = true; void toggleStatusMod(!modEnabled); };
  const toolsLimited = Boolean(currentConfig.cli && currentConfig.cli.limitWorkerTools);
  const toolsSwitch = $("#client-worker-tools-toggle");
  toolsSwitch.checked = toolsLimited;
  toolsSwitch.onchange = () => { toolsSwitch.disabled = true; void toggleWorkerTools(!toolsLimited).finally(() => { toolsSwitch.disabled = false; }); };
  void renderCodexClient();
  const groups = groupedModels(currentConfig);
  const mapped = Object.entries(currentConfig.routes || {}).map(([source, route]) => cell(
    labelOf(claudeModels.find((model) => model.id === source) || { id: source }),
    el("span", { text: labelOf((groups.find((group) => group.name === route.provider) || { models: [] }).models.find((model) => model.id === route.model) || { id: route.model }) }),
  ));
  $("#client-claude-code-rows").replaceChildren(...(mapped.length ? mapped : [el("div", { class: "cell-note", text: t("slots.noChanges") })]));
}
function renderClientPickerModels(enabled) {
  const card = $("#client-picker-models-card");
  card.hidden = !enabled;
  if (!enabled) return;
  const box = $("#client-picker-models");
  const checked = new Set(((currentConfig.cli && currentConfig.cli.extraModels) || []).map((item) => item.model));
  box.replaceChildren();
  for (const group of groupedModels(currentConfig)) for (const model of group.models) {
    const input = el("input", { type: "checkbox", checked: checked.has(model.id) });
    input.dataset.model = model.id;
    input.dataset.provider = group.name;
    input.dataset.name = labelOf(model);
    const discovered = discoveredContextWindow(group.name, model.id);
    const saved = savedContextWindow(model.id);
    // Blank means "use the global fallback"; the placeholder says what that would be.
    const windowField = el("input", {
      type: "number", class: "model-window", min: "1", step: "1000",
      value: saved !== undefined ? String(saved) : "",
      placeholder: discovered !== undefined ? String(discovered) : t("slots.windowGlobal"),
      title: t("slots.windowHelp"),
    });
    windowField.hidden = !input.checked;
    windowField.dataset.model = model.id;
    windowField.addEventListener("change", () => void saveClientPickerModels());
    input.addEventListener("change", () => { windowField.hidden = !input.checked; void saveClientPickerModels(); });
    // Two lines: the name owns the first — on one line it was the thing that collapsed, down to
    // "GPT…" — and the provider and the window share the second. The field sits outside the
    // <label>, because inside it every click toggles the checkbox instead of reaching the field.
    box.appendChild(el("div", { class: "picker-model", title: model.id }, [
      el("label", { class: "pm-main" }, [input, el("span", { text: labelOf(model) })]),
      el("small", { text: group.name }),
      windowField,
    ]));
  }
  if (!box.childElementCount) box.appendChild(hint(t("slots.noProviderModels")));
}
// Claude Code picks these before a request exists, so routing cannot reach them: a search, a title
// or a subagent goes wherever the CLI already decided. Left empty, Claude answers them — which is
// why a routed session still searches on Claude quota until `smallFast` is pointed somewhere.
const MODEL_SLOTS = ["smallFast", "subagent", "main"];

// A provider the router measured as unable to search. Only the router can know this — it comes from
// the status snapshot, never from the model's name — and the `smallFast` slot is exactly where it
// matters, because a search sent to such a model comes back as invented prose or a visible failure.
// A plan that searches on another of its endpoints does so for the models it names only.
function providerCannotSearch(name, model) {
  const entry = status && status.providers && status.providers[name];
  if (!entry || entry.webSearch === true) return false;
  const id = String(model || "").replace(/@[^@]*$/, "");
  return !(Array.isArray(entry.webSearchModels) && entry.webSearchModels.includes(id));
}

// The web search row names a provider as well as a model: one id can be offered by two providers
// and only one of them may be able to run a search. JSON keeps the two apart whatever they contain.
function webSearchChoice(provider, model) { return JSON.stringify([provider, model]); }
function parseWebSearchChoice(value) {
  if (!value) return null;
  try {
    const [provider, model] = JSON.parse(value);
    return typeof provider === "string" && typeof model === "string" ? { provider, model } : null;
  } catch { return null; }
}

function renderModelSlots() {
  const rows = $("#client-model-slots");
  if (!rows) return;
  const chosen = (currentConfig.cli && currentConfig.cli.models) || {};
  // With a web search backend set, the search is intercepted before routing and never reaches
  // `smallFast`, so the "no web search here" label there would be false.
  const searchIntercepted = Boolean(currentConfig.webSearch);
  const nodes = MODEL_SLOTS.map((slot) => {
    const select = el("select", {});
    select.appendChild(el("option", { value: "", text: t("slots.slotDefault") }));
    for (const group of groupedModels(currentConfig)) for (const model of group.models) {
      const option = el("option", { value: model.id, text: `${labelOf(model)} · ${group.name}` });
      if (chosen[slot] === model.id) option.selected = true;
      // `smallFast` is what a WebSearch runs on, so an inability to search is fatal there and
      // merely worth knowing everywhere else.
      if (slot === "smallFast" && !searchIntercepted && providerCannotSearch(group.name, model.id)) {
        option.textContent += ` — ${t("slots.noWebSearch")}`;
      }
      select.appendChild(option);
    }
    // A model the config names but no provider offers any more would otherwise vanish silently.
    if (chosen[slot] && !allKnownModelIds(currentConfig).has(chosen[slot])) {
      const orphan = el("option", { value: chosen[slot], text: `${chosen[slot]} (?)` });
      orphan.selected = true;
      select.appendChild(orphan);
    }
    select.onchange = () => void saveModelSlots();
    select.dataset.slot = slot;
    select.setAttribute("aria-label", t(`slots.slot.${slot}`));
    return cell(t(`slots.slot.${slot}`), select, t(`slots.slotHelp.${slot}`), "slot-row");
  });
  nodes.push(renderWebSearchSlot());
  rows.replaceChildren(...nodes);
}

// The backend `cfg.webSearch` names answers the search instead of the `smallFast` slot. Only the
// router knows which models it can actually search with — that comes from `/api/status`, never
// from a model's name — so an unsearchable model is not offered here at all.
function renderWebSearchSlot() {
  const saved = currentConfig.webSearch || null;
  const select = el("select", {});
  select.appendChild(el("option", { value: "", text: t("slots.webSearchFollow") }));
  let found = false;
  for (const group of groupedModels(currentConfig)) for (const model of group.models) {
    if (providerCannotSearch(group.name, model.id)) continue;
    // A Claude account searches on its own when routed to, but `serveWebSearch` has no backend for
    // that provider kind: named here, the search would quietly fall back to `smallFast`.
    if (currentConfig.providers[group.name] && currentConfig.providers[group.name].type === "anthropic") continue;
    const option = el("option", { value: webSearchChoice(group.name, model.id), text: `${labelOf(model)} · ${group.name}` });
    if (saved && saved.provider === group.name && saved.model === model.id) { option.selected = true; found = true; }
    select.appendChild(option);
  }
  // A backend the config names but no provider can run any more must not read as "follows the
  // small, fast model" — that would silently change where the search goes.
  if (saved && !found) {
    const orphan = el("option", { value: webSearchChoice(saved.provider, saved.model), text: `${saved.provider} / ${saved.model} (?)` });
    orphan.selected = true;
    select.appendChild(orphan);
  }
  select.onchange = () => void saveWebSearch(select.value);
  select.dataset.webSearch = "true";
  select.setAttribute("aria-label", t("slots.webSearch"));
  return cell(t("slots.webSearch"), select, t("slots.webSearchHelp"), "slot-row");
}

async function saveWebSearch(value) {
  if (!currentConfig) return;
  const next = clone(await latestConfig());
  const picked = parseWebSearchChoice(value);
  // `webSearch` is the only setting this row owns; an existing `maxResults` survives the change.
  const maxResults = (next.webSearch && next.webSearch.maxResults) ?? (currentConfig.webSearch && currentConfig.webSearch.maxResults);
  if (picked) next.webSearch = { provider: picked.provider, model: picked.model, ...(maxResults !== undefined ? { maxResults } : {}) };
  else delete next.webSearch;
  try {
    await configRequest(next);
    currentConfig = next;
    renderModelSlots();
    toast(t("slots.webSearchSaved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

async function saveModelSlots() {
  if (!currentConfig) return;
  const next = clone(await latestConfig());
  // Every slot is recorded, empty ones included. A select put back to "default (Claude)" has to
  // remove the env key, and the router tells "clear this" from "leave this alone" by whether the
  // slot is present at all — so dropping empty values here would make the choice a silent no-op.
  const models = {};
  // Only the three slot rows: the web search row below them writes `webSearch`, not a slot.
  for (const select of $all("#client-model-slots select[data-slot]")) models[select.dataset.slot] = select.value;
  next.cli = { ...(next.cli || {}), models };
  try {
    await configRequest(next);
    currentConfig = next;
    // Saying "saved" over a choice that will make every search fail is the same silent no-op this
    // screen was already guilty of once. The label on the option warns before the fact; this catches
    // a session that already had it selected. With a web search backend set the search never
    // reaches `smallFast`, so there is nothing to warn about.
    const owners = models.smallFast && !next.webSearch ? providersOffering(next, models.smallFast) : [];
    if (owners.length && providerCannotSearch(owners[0], models.smallFast)) toast(t("slots.noWebSearchWarn"), true);
    else toast(t("slots.slotSaved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

function clientPickerSelections() {
  return $all("#client-picker-models input[type=checkbox]:checked").map((input) => {
    const field = $(`#client-picker-models input.model-window[data-model="${CSS.escape(input.dataset.model)}"]`);
    const typed = field && field.value.trim() ? Number(field.value) : NaN;
    const contextWindow = Number.isFinite(typed) && typed > 0 ? Math.floor(typed) : discoveredContextWindow(input.dataset.provider, input.dataset.model);
    return { id: input.dataset.model, name: input.dataset.name, provider: input.dataset.provider, contextWindow };
  });
}
async function saveClientPickerModels() {
  if (!currentConfig) return;
  const next = applyPickerSelections(clone(await latestConfig()), clientPickerSelections());
  try { await configRequest(next); currentConfig = next; toast(t("slots.saved")); } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}
function pickerModeOn() {
  return Boolean(status && status.picker && status.picker.enabled);
}
// Ticking "show in the Claude app picker" only records which models to show; nothing appears until
// picker mode itself is on. Ask right after saving so the user is not left with a silent no-op
// (the box was ticked, picker mode stayed off, and the picker never changed — seen on Windows, 2026-09-14).
async function offerPickerOn(wanted) {
  if (!wanted || pickerModeOn()) return;
  if (!confirm(t("providers.pickerOffPrompt"))) return;
  await togglePicker(true, true);
}
async function togglePicker(enabled, confirmed = false) {
  if (pickerBusy) return;
  if (enabled && !confirmed && !confirm(t("picker.confirmOn"))) return;
  pickerBusy = true;
  $("#client-picker-msg").textContent = t("picker.working");
  try {
    await api("/api/picker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    toast(enabled ? t("picker.doneOn") : t("picker.doneOff"));
    if (currentConfig) currentConfig.picker = { ...(currentConfig.picker || {}), enabled };
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    pickerBusy = false;
    $("#client-picker-msg").textContent = "";
    void refreshHealth();
  }
}
async function toggleStatusMod(enabled) {
  if (statusModBusy) return;
  statusModBusy = true;
  try {
    await api("/api/status-mod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    toast(t("statusMod.saved"));
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    statusModBusy = false;
    void refreshHealth();
  }
}
async function toggleWorkerTools(enabled) {
  if (!currentConfig) return;
  const next = clone(await latestConfig());
  next.cli = { ...(next.cli || {}), limitWorkerTools: enabled };
  try {
    await configRequest(next);
    currentConfig = next;
    toast(t("common.saved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
  renderClients();
}
async function renderCodexClient() {
  const path = $("#client-codex-rows");
  const toggle = $("#client-codex-toggle");
  try {
    const codex = await api("/api/codex");
    path.textContent = codex.configPath || "";
    path.classList.remove("bad-text");
    toggle.checked = Boolean(codex.enabled);
    toggle.disabled = codexBusy;
    toggle.onchange = () => { toggle.disabled = true; void toggleCodex(!codex.enabled); };
  } catch (error) {
    path.textContent = error.message;
    path.classList.add("bad-text");
    toggle.disabled = true;
  }
}
async function toggleCodex(enabled) {
  if (codexBusy) return;
  codexBusy = true;
  $("#client-codex-msg").textContent = t("picker.working");
  try { const result = await api("/api/codex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); toast(t("common.saved"), false, result.output); }
  catch (error) { toast(t("common.actionFailed"), true, error.message); }
  finally { codexBusy = false; $("#client-codex-msg").textContent = ""; void renderCodexClient(); }
}
void Promise.all([loadCatalogs(), refreshHealth()]);
setInterval(refreshHealth, 5000);

// ---- Phone --------------------------------------------------------------------------

function hidePhoneQr() {
  phoneQrGeneration++;
  const box = $("#phone-qr");
  if (box) box.replaceChildren();
}
function phoneActive() { return $("#view-phone").classList.contains("active"); }
function phonePost(route, body) {
  return api(`/api/phone/${route}`, { method: "POST", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function showPhoneQr(button) {
  if (phoneBusy) return;
  const generation = ++phoneQrGeneration;
  button.disabled = true;
  try {
    const pairing = await api("/api/phone/pairing");
    if (generation !== phoneQrGeneration || !phoneActive()) return;
    const copy = el("button", { class: "btn secondary", type: "button", text: t("phone.copyLink") });
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pairing.url); toast(t("phone.copied")); }
      catch { toast(t("phone.copyFailed"), true); }
    });
    // An image, never trusted SVG markup in the dashboard's DOM.
    $("#phone-qr").replaceChildren(el("img", { class: "phone-qr-image", alt: t("phone.qrAlt"), src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.svg)}`, width: "240", height: "240" }), copy,
      el("button", { class: "btn secondary", type: "button", text: t("common.hide"), onclick: hidePhoneQr }));
  } catch { if (generation === phoneQrGeneration) toast(t("common.loadFailed"), true); }
  finally { button.disabled = false; }
}
// Ripple Remote in the stores. iPhone links to the storefront of the dashboard's language, as the
// README headers do; Android is a closed test on Google Play, joined through Discord, so no Play link.
const REMOTE_STOREFRONT = { ko: "kr", en: "us", zh: "us", ja: "jp", es: "es", pt: "br" };
/** Read when drawn, not at load: this block is also evaluated on its own by the phone tests. */
function remoteAppStoreUrl() { return `https://apps.apple.com/${REMOTE_STOREFRONT[CURRENT_LANG] || "us"}/app/id6823063731`; }
const COMMUNITY_URL = "https://discord.gg/R8ZgGSNHjw";
function externalLink(href, cls, children) { return el("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, children); }
function phonePaired(data) { return Boolean(data && data.hostRunning && data.phones && data.phones.length); }
function remoteAndroidNote(cls) { return el("span", { class: `${cls} remote-android` }, [t("phone.promo.android"), " · ", externalLink(COMMUNITY_URL, "login-link", [t("phone.promo.androidLink")])]); }
/** No phone paired yet: what the app does that nothing else does, the store, and how the QR below fits in. */
function remotePromo(data) {
  const points = ["models", "hours", "private"].map(key => el("li", {}, [el("strong", { text: t(`phone.promo.${key}`) }), " ", t(`phone.promo.${key}Body`)]));
  const phoneGlyph = svgIcon("0 0 20 20", ["M7 2h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M8.5 14.8h3"]);
  const download = svgIcon("0 0 20 20", ["M10 3.5v9", "M6.2 9l3.8 3.8L13.8 9", "M4.5 16.5h11"], "remote-store-icon");
  // Its own lang, so Korean wraps between words in a browser too (the app sets it on <html>).
  return el("section", { class: "conn-card remote-promo", lang: CURRENT_LANG }, [
    el("div", { class: "conn-hero" }, [el("div", { class: "conn-icon" }, [phoneGlyph]), el("div", { class: "conn-hero-text" }, [
      el("p", { class: "remote-eyebrow", text: t("phone.promo.eyebrow") }),
      el("h2", { class: "conn-title", text: t("phone.promo.title") }),
      el("p", { class: "conn-lead", text: t("phone.promo.lead") }),
    ])]),
    el("ul", { class: "remote-points" }, points),
    el("div", { class: "remote-get" }, [externalLink(remoteAppStoreUrl(), "btn large remote-store", [download, t("phone.promo.appStore")]), remoteAndroidNote("hint")]),
    el("p", { class: "remote-next", text: t(data.hostRunning ? "phone.promo.nextQr" : "phone.promo.nextHost") }),
  ]);
}
/** A phone is paired already: one quiet row for the next phone instead of the pitch. */
function remoteGetApp() {
  return section(null, [cell(t("phone.promo.compact"), externalLink(remoteAppStoreUrl(), "btn secondary compact", [t("phone.promo.appStoreShort")]), [remoteAndroidNote("cell-sub")])]);
}
function renderPhoneStatus(data) {
  const rows = [cell(t("phone.host"), badge(data.hostRunning ? "ok" : "warn", t(data.hostRunning ? "phone.running" : "phone.stopped")))];
  if (data.hostRunning) rows.push(cell(t("phone.mode"), el("span", { text: t(data.mode === "relay" ? "phone.relayStatus" : data.mode === "direct" ? "phone.directStatus" : "phone.localStatus") }), `${data.bind}:${data.port} · ${data.version}`),
    cell(t("phone.notifications"), badge(data.pushReady ? "ok" : "warn", t(data.pushReady ? "phone.ready" : "phone.needsRelay"))));
  else rows.push(el("div", { class: "cell-note" }, [hint(t("phone.install")), el("code", { text: data.hint })]));
  $("#phone-status").replaceChildren(...rows);
  if (!data.hostRunning) return;
  $("#phone-phones").replaceChildren(...(data.phones.length ? data.phones.map(phone => cell(
    el("span", { class: "cell-label mono", text: phone.clientId.length > 12 ? `${phone.clientId.slice(0, 12)}…` : phone.clientId, title: phone.clientId }),
    badge(phone.connected ? "ok" : "", t(phone.connected ? "phone.connected" : "phone.offline")),
    [phone.lastSeen ? t("phone.lastSeen", { time: new Date(phone.lastSeen).toLocaleString(CURRENT_LANG) }) : t("phone.unknownSeen"), t(phone.push ? "phone.pushOn" : "phone.pushOff")],
  )) : [el("div", { class: "cell-note", text: t("phone.empty") })]));
  $("#phone-restart").hidden = !data.restartRequired;
}
function phoneSettings(data) {
  // The phone app pairs through the Relay only, so phone access is on (Relay) or off. A custom
  // relay address stays in the host's config file; the dashboard keeps whichever one is saved.
  const saved = data.settings;
  const selected = saved.relay ? "relay" : "local";
  const choices = ["relay", "local"].map(value => {
    const radio = el("input", { type: "radio", name: "phone-mode", value, checked: value === selected });
    return el("label", { class: "cell phone-choice" }, [radio, el("span", { class: "cell-text" }, [el("span", { class: "cell-label", text: t(`phone.choice.${value}`) }), el("span", { class: "cell-sub", text: t(`phone.help.${value}`) })])]);
  });
  const save = el("button", { class: "btn", type: "button", text: t("common.save") });
  save.addEventListener("click", async () => {
    if (phoneBusy) return;
    const mode = $('#phone-content input[name="phone-mode"]:checked').value;
    phoneBusy = true; save.disabled = true;
    hidePhoneQr();
    try {
      const result = await phonePost("settings", mode === "relay" ? { relay: saved.relay || data.defaultRelay, bind: "local" } : { relay: "off", bind: "local" });
      toast(t(result.restartRequired ? "phone.restartRequired" : "common.saved"));
      await refreshPhone();
    } catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { phoneBusy = false; save.disabled = false; }
  });
  return section(t("phone.settings"), [...choices, cell(t("phone.apply"), save)]);
}
function phoneRestart() {
  const button = el("button", { class: "btn secondary", type: "button", text: t("phone.restart") });
  const message = hint("");
  button.addEventListener("click", async () => {
    if (!confirm(t("phone.restartConfirm"))) return;
    button.disabled = true;
    hidePhoneQr();
    try {
      const result = await phonePost("restart");
      if (result.manual) message.textContent = t("phone.manualRestart", { command: result.command });
      else { toast(t("phone.restarting")); setTimeout(() => void loadPhone(), 2000); }
    } catch (error) { toast(t("common.actionFailed"), true, error.message); }
    finally { button.disabled = false; }
  });
  return el("div", { id: "phone-restart", class: "group stacked-group", hidden: "" }, [cell(t("phone.restartRequired"), button, message, "wide")]);
}
function phoneControls(data) {
  const qr = el("button", { class: "btn secondary", type: "button", text: t("phone.showQr") });
  qr.addEventListener("click", () => void showPhoneQr(qr));
  const rotate = el("button", { class: "cell-button destructive", type: "button", text: t("phone.rotate") });
  rotate.addEventListener("click", async () => {
    if (phoneBusy || !confirm(t("phone.rotateConfirm"))) return;
    phoneBusy = true; rotate.disabled = true; hidePhoneQr();
    try { await phonePost("rotate"); toast(t("phone.rotated")); await refreshPhone(); }
    catch (error) { toast(t("common.actionFailed"), true, error.message); }
    finally { phoneBusy = false; rotate.disabled = false; }
  });
  const phones = section(t("phone.phones"), []);
  $(".group", phones).id = "phone-phones";
  return [section(t("phone.pairing"), [cell(t("phone.scan"), qr, t("phone.scanHelp")), el("div", { id: "phone-qr", class: "phone-qr" })], [t("phone.qrWarning"), !data.reachableFromPhone ? t("phone.unreachable") : null]),
    phoneSettings(data), phoneRestart(), phones, phonePaired(data) ? remoteGetApp() : null, section(null, [rotate], t("phone.sharedKey"))].filter(Boolean);
}
async function refreshPhone(rebuild = false) {
  if (!phoneActive() || offline()) return;
  const generation = phoneGeneration;
  try {
    const data = await api("/api/phone/status");
    if (generation !== phoneGeneration || !phoneActive()) return;
    // Pairing the first phone (or unpairing the last) swaps the pitch for its one-row form, so it rebuilds too.
    if (rebuild || !phoneSnapshot || phoneSnapshot.hostRunning !== data.hostRunning || phonePaired(phoneSnapshot) !== phonePaired(data)) {
      hidePhoneQr();
      const state = section(t("phone.status"), []);
      $(".group", state).id = "phone-status";
      $("#phone-content").replaceChildren(...(phonePaired(data) ? [] : [remotePromo(data)]), state, ...(data.hostRunning ? phoneControls(data) : []));
    }
    phoneSnapshot = data;
    renderPhoneStatus(data);
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}
async function loadPhone() { phoneGeneration++; hidePhoneQr(); await refreshPhone(true); }
$("#phone-refresh").addEventListener("click", () => void loadPhone());
setInterval(() => { if (!phoneBusy) void refreshPhone(); }, 5000);

// ---- Laptop: awake with the lid closed, and the phone hotspot when Wi-Fi fails -------------
// GET|PUT /api/power (router power.ts) and POST|GET /api/power/setup, which runs the CLI's
// `awake setup` — macOS shows its own password dialog, Windows needs none. Written for someone who
// has never heard of pmset: the router's reasons and states are English codes, so each is turned
// into a sentence here. The power status names its platform, so wording and setup follow it rather
// than assuming a Mac and an iPhone (Windows: awake-win.ts, tether-win.ts).

let macPower = null;
/** null, "unavailable" (a router without the feature) or a load error. */
let macError = null;
let macSetup = { running: false };
/** A setup run this page started or saw running: its progress and result are shown. */
let macSetupWatched = false;
let macSetupPoll = null;
let macBusy = false;
let macGeneration = 0;
let macSsidDraft = null;
const macOpen = { awake: false, tether: false, setup: false };

/** The OS the router reports. A router too old to name it had macOS-only power features. */
function macPlatform() { return (macPower && macPower.platform) || "darwin"; }
function macIsMac() { return macPlatform() === "darwin"; }
function macActive() { return $("#view-mac").classList.contains("active"); }
async function loadMac() { macGeneration++; macDrawn = ""; await refreshMac(true); }
async function refreshMac(force) {
  if (!macActive() || offline()) return;
  const generation = macGeneration;
  const [power, setup] = await Promise.allSettled([api("/api/power"), api("/api/power/setup")]);
  if (generation !== macGeneration || !macActive()) return;
  if (power.status === "fulfilled") { macPower = power.value; macError = null; }
  else macError = power.reason && power.reason.status === 501 ? "unavailable" : (power.reason && power.reason.message) || "error";
  if (setup.status === "fulfilled") macAdoptSetup(setup.value);
  // A field being typed in is not redrawn under the cursor; the next refresh catches up.
  const focused = document.activeElement;
  if (!force && focused && $("#mac-content").contains(focused) && focused.matches("input:not([type=checkbox])")) return;
  renderMac();
}
function macAdoptSetup(next) {
  const was = macSetup;
  macSetup = next || { running: false };
  if (macSetup.running) {
    macSetupWatched = true;
    if (!macSetupPoll) macSetupPoll = setInterval(() => void macPollSetup(), 1500);
  } else if (macSetupPoll) {
    clearInterval(macSetupPoll);
    macSetupPoll = null;
  }
  if (was.running && !macSetup.running && macSetupWatched) {
    toast(t(macSetup.ok ? "mac.setup.done" : /cancel/i.test(macSetup.output || "") ? "mac.setup.cancelled" : "mac.setup.failed"), !macSetup.ok);
    // Success shows as the controls coming alive; only a failure stays on screen to be read.
    if (macSetup.ok) macSetupWatched = false;
  }
}
async function macPollSetup() {
  try { macAdoptSetup(await api("/api/power/setup")); } catch { return; }
  if (!macSetup.running) {
    // The router looks for the rule again when the run ends; read what it found.
    try { macPower = await api("/api/power"); } catch { /* the 5s refresh retries */ }
  }
  if (macActive()) renderMac();
}
async function startMacSetup(ssid) {
  if (macSetup.running) return;
  try {
    await api("/api/power/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ssid ? { ssid } : {}) });
    macSetupWatched = true;
    macOpen.setup = false;
    macAdoptSetup({ running: true, startedAt: new Date().toISOString() });
  } catch (error) {
    if (error.status === 409) { macSetupWatched = true; macAdoptSetup({ running: true }); }
    else toast(t("mac.setup.failed"), true, error.message);
  }
  renderMac();
}
async function macPut(change) {
  if (macBusy) return;
  macBusy = true;
  try {
    macPower = await api("/api/power", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
  } catch (error) {
    toast(t("common.saveFailed"), true, error.message);
    // Nothing changed, but the switch or field that was touched shows the change: draw it back.
    macDrawn = "";
  }
  finally { macBusy = false; }
  renderMac();
}

/** The same rule the router holds a hotspot name to (config.ts ssidProblem), said in words. */
function macSsidProblem(name) {
  if (!name) return null;
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > 32 || !/^[A-Za-z0-9 ._'’-]+$/u.test(name) || /^ | $| {2}/.test(name) || name.startsWith("-")) return t("mac.ssid.invalid");
  return null;
}
function macTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(CURRENT_LANG, { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return t("mac.tomorrowAt", { time });
  return `${d.toLocaleDateString(CURRENT_LANG, { month: "short", day: "numeric" })} ${time}`;
}
/** "HH:MM" → the next time the clock shows it, as an ISO instant. */
function macNextAt(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}
function macHHMM(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The router's one-line reason (awake.ts decideAwake) as a sentence, with whether it is a warning. */
function macAwakeWhy(a) {
  const r = String(a.reason || "");
  let m;
  if (r === "off") return { text: t("mac.why.off") };
  if (r === "on") return { text: a.until ? t("mac.why.onUntil", { time: macTime(a.until) }) : t("mac.why.on") };
  if (/^working: \d+ model call/.test(r)) return { text: t("mac.why.working") };
  if ((m = /^working: last model call (\d+)s ago/.exec(r))) return { text: t("mac.why.recent", { min: Math.max(1, Math.round(Number(m[1]) / 60)) }) };
  if (r.startsWith("idle")) return { text: t("mac.why.idle") };
  if (/^until .* has passed$/.test(r)) return { text: t("mac.why.until") };
  if ((m = /^battery (\d+)% is below (\d+)%/.exec(r))) return { text: t("mac.why.battery", { floor: m[2], percent: m[1] }), warn: true };
  if (r === "thermal warning") return { text: t("mac.why.thermal"), warn: true };
  if (r.startsWith("error:")) return { text: t("mac.why.error"), warn: true };
  if (r.startsWith("needs setup")) return { text: t("mac.why.setup"), warn: true };
  if (r.startsWith("pmset failed")) return { text: t("mac.why.failed"), warn: true };
  // Windows (awake-win.ts): the helper's own failures and a refused power-plan write.
  if (/^(SetThreadExecutionState failed|Windows refused|could not restore the lid-close action)/.test(r)) return { text: t("mac.why.failed"), warn: true };
  if (r === "not started") return { text: t("mac.why.starting") };
  return { text: r };
}
function macFacts(a) {
  const facts = [];
  if (a.battery && typeof a.battery.percent === "number") facts.push(t(a.battery.onBattery ? "mac.fact.battery" : "mac.fact.charging", { percent: a.battery.percent }));
  if (a.lidClosed === true) facts.push(t("mac.fact.lidClosed"));
  else if (a.lidClosed === false) facts.push(t("mac.fact.lidOpen"));
  if (a.thermal === "warning") facts.push(t("mac.fact.hot"));
  return facts.join(" · ");
}
/** A status line: a coloured dot, what is true now in a word or two, and why underneath. */
function macStateRow(tone, title, sub, side) {
  return el("div", { class: "cell mac-state" }, [
    el("span", { class: `mac-dot ${tone}`, "aria-hidden": "true" }),
    el("div", { class: "cell-text" }, [el("span", { class: "cell-label strong", text: title }), sub ? el("span", { class: "cell-sub", text: sub }) : null]),
    side ? el("span", { class: "mac-side", text: side }) : null,
  ]);
}
function macDetails(key, rows) {
  const box = el("details", { class: "details mac-details" }, [
    el("summary", { text: t("mac.details") }),
    el("div", { class: "group conn-detail-rows" }, rows.filter(Boolean).map(([k, v]) => el("div", { class: "row" }, [el("span", { class: "k", text: k }), el("span", { class: "v mono", text: v })]))),
  ]);
  box.open = macOpen[key];
  box.addEventListener("toggle", () => { macOpen[key] = box.open; });
  return box;
}

function macSetupNote() {
  if (macSetup.running) {
    // macOS opens its own password window; Windows only checks (no password, no elevation).
    const title = t(macIsMac() ? "mac.setup.waiting" : "mac.setup.waitingWin");
    const sub = t(macIsMac() ? "mac.setup.waitingSub" : "mac.setup.waitingSubWin");
    return el("div", { class: "conn-note busy", role: "status" }, [el("span", { class: "spinner", "aria-hidden": "true" }),
      el("div", { class: "conn-note-text" }, [el("strong", { text: title }), el("span", { text: sub })])]);
  }
  if (!macSetupWatched || macSetup.ok === undefined) return null;
  const cancelled = /cancel/i.test(macSetup.output || "");
  const good = macSetup.ok === true;
  const output = el("details", { class: "conn-fold" }, [el("summary", { text: t("mac.details") }), el("pre", { text: macSetup.output || "" })]);
  output.open = macOpen.setup;
  output.addEventListener("toggle", () => { macOpen.setup = output.open; });
  return el("div", { class: `conn-note ${good ? "good" : "bad"}`, role: "status" }, [
    el("div", { class: "conn-note-line" }, [
      svgIcon("0 0 20 20", good ? ["M4.5 10.5l3.5 3.5 7.5-8"] : ["M5.5 5.5l9 9M14.5 5.5l-9 9"], "conn-note-icon"),
      el("span", { text: t(good ? "mac.setup.done" : cancelled ? "mac.setup.cancelled" : "mac.setup.failed") }),
    ]),
    macSetup.output ? output : null,
  ]);
}
function macSetupCard(p) {
  const saved = (p.tether && p.tether.hotspotSsid) || "";
  if (macSsidDraft === null) macSsidDraft = saved;
  const input = el("input", { type: "text", id: "mac-ssid", value: macSsidDraft, placeholder: t("mac.ssid.placeholder"), autocomplete: "off", spellcheck: "false", maxlength: "32" });
  const problem = el("small", { class: "bad-text", role: "alert" });
  const button = el("button", { class: "btn large", type: "button", "data-key": "mac-setup", text: t(macSetup.running ? "mac.setup.running" : "mac.setup.button") });
  const check = () => {
    const issue = macSsidProblem(input.value.trim());
    problem.textContent = issue || "";
    problem.hidden = !issue;
    button.disabled = Boolean(issue) || macSetup.running;
  };
  input.addEventListener("input", () => { macSsidDraft = input.value; check(); });
  button.addEventListener("click", () => void startMacSetup(input.value.trim()));
  check();
  input.disabled = macSetup.running;
  const allow = ["mac.setup.allowSleep", "mac.setup.allowLid", "mac.setup.allowHotspot"];
  return el("section", { class: "conn-card mac-setup", "aria-labelledby": "mac-setup-title" }, [
    el("div", { class: "conn-hero" }, [
      el("div", { class: "conn-icon" }, [svgIcon("0 0 20 20", ["M6 9V6.5a4 4 0 0 1 8 0V9", "M5 9h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"])]),
      el("div", { class: "conn-hero-text" }, [
        el("h2", { class: "conn-title", id: "mac-setup-title", text: t("mac.setup.title") }),
        el("p", { class: "conn-lead", text: t("mac.setup.lead") }),
      ]),
    ]),
    el("ul", { class: "mac-allow" }, allow.map((key) => el("li", { text: t(key) }))),
    el("p", { class: "hint mac-setup-note", text: t("mac.setup.private") }),
    el("p", { class: "hint mac-setup-note", text: t("mac.setup.insomnia") }),
    el("label", { class: "form-field" }, [el("span", { text: t("mac.ssid.label") }), input, problem, el("small", { text: t("mac.ssid.help") })]),
    el("div", { class: "mac-setup-actions" }, [button]),
    macSetupNote(),
  ]);
}
function openMacRename(current) {
  const input = el("input", { type: "text", value: current, placeholder: t("mac.ssid.placeholder"), autocomplete: "off", spellcheck: "false", maxlength: "32" });
  const problem = el("small", { class: "bad-text", role: "alert", hidden: "" });
  const save = el("button", { class: "btn", type: "button", "data-default-action": "", text: t("mac.rename.save") });
  const check = () => {
    const name = input.value.trim();
    const issue = macSsidProblem(name);
    problem.textContent = issue || "";
    problem.hidden = !issue;
    save.disabled = !name || Boolean(issue) || name === current;
  };
  input.addEventListener("input", check);
  save.addEventListener("click", () => { const name = input.value.trim(); closeModal(); void startMacSetup(name); });
  check();
  showModal(el("div", {}, [
    el("h1", { text: t(current ? "mac.rename.title" : "mac.rename.titleNew") }),
    hint(t("mac.rename.help")),
    el("label", { class: "form-field" }, [el("span", { text: t("mac.ssid.label") }), input, problem, el("small", { text: t("mac.ssid.help") })]),
    el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), save]),
  ]));
}

function macAwakeCard(a) {
  const why = macAwakeWhy(a);
  const state = a.applied
    ? macStateRow("on", t("mac.awake.on"), why.text, macFacts(a))
    : macStateRow(why.warn ? "warn" : "off", t("mac.awake.off"), why.text, macFacts(a));
  const modes = [{ value: "off", label: t("mac.mode.off") }, { value: "working", label: t("mac.mode.working") }, { value: "on", label: t("mac.mode.on") }];
  const rows = [
    state,
    cell(el("span", { class: "cell-label", text: t("mac.mode.label") }),
      modSegmented("mac-mode", modes, a.mode, t("mac.mode.label"), (mode) => void macPut({ awake: { mode, until: null } })),
      t(`mac.mode.${a.mode}Help`), "wide"),
  ];
  if (a.mode === "on") {
    const time = el("input", { type: "time", class: "mac-time", "data-key": "mac-until", value: a.until ? macHHMM(a.until) : "", "aria-label": t("mac.until.label") });
    // Saved when the field is left, not on each keystroke: a redraw mid-typing would eat the minutes.
    const commit = () => {
      const until = time.value ? macNextAt(time.value) : null;
      if (time.value && !until) return;
      if ((until ? macHHMM(until) : "") === (a.until ? macHHMM(a.until) : "")) return;
      void macPut({ awake: { until } });
    };
    time.addEventListener("blur", commit);
    time.addEventListener("keydown", (event) => { if (event.key === "Enter") time.blur(); });
    const clear = a.until ? el("button", { class: "link-btn", type: "button", "data-key": "mac-until-clear", text: t("mac.until.clear"), onclick: () => void macPut({ awake: { until: null } }) }) : null;
    rows.push(cell(t("mac.until.label"), [time, clear], a.until ? t("mac.until.set", { time: macTime(a.until) }) : t("mac.until.none")));
  }
  return el("section", { class: "mod-card mac-card", "aria-labelledby": "mac-awake-title" }, [
    el("div", { class: "mod-card-head" }, [el("h2", { id: "mac-awake-title", text: t("mac.awake.title") }), hint(t("mac.awake.blurb"))]),
    el("div", { class: "group" }, rows),
    el("p", { class: "group-footer", text: t("mac.awake.safety", { floor: macBatteryFloor(a) }) }),
    macDetails("awake", [
      [t("mac.d.reason"), a.reason || "—"],
      [t("mac.d.applied"), a.applied ? (macIsMac() ? "disablesleep 1" : "ES_SYSTEM_REQUIRED") : macIsMac() ? "disablesleep 0" : "—"],
      [t("mac.d.battery"), a.battery ? `${a.battery.percent ?? "?"}% · ${a.battery.onBattery ? "battery" : "AC"}` : "—"],
      [t("mac.d.thermal"), a.thermal || "—"],
      [t("mac.d.lid"), a.lidClosed === null || a.lidClosed === undefined ? "—" : a.lidClosed ? "closed" : "open"],
      [t("mac.d.until"), a.until || "—"],
    ]),
  ]);
}
/** The battery floor is in config, not in the status; the reason names it when it bites. */
function macBatteryFloor(a) {
  const m = /below (\d+)%/.exec(String(a.reason || ""));
  return m ? m[1] : "20";
}

const MAC_HINT_STATES = new Set(["hotspot-not-visible", "join-failed", "no-wifi", "no-hotspot-ssid", "needs-setup", "no-hotspot-profile", "needs-location"]);
function macTetherCard(tt, setupOk) {
  const network = tt.network === "hotspot" ? "hotspot" : tt.network === "wifi" ? "wifi" : "none";
  const tone = network === "wifi" ? "ok" : network === "hotspot" ? "on" : "bad";
  let side = "";
  if (tt.lastSwitch) {
    const time = macTime(tt.lastSwitch.at);
    side = !tt.lastSwitch.ok ? t("mac.switch.failed", { time }) : t(tt.lastSwitch.to === "hotspot" ? "mac.switch.toHotspot" : "mac.switch.toWifi", { time });
  }
  const enabled = modSwitch("mac-tether", tt.enabled, t("mac.tether.switch"), (on) => void macPut({ tether: { enabled: on } }));
  const name = tt.hotspotSsid || "";
  const rename = el("button", { class: "btn secondary compact", type: "button", "data-key": "mac-rename", text: t(name ? "mac.ssid.change" : "mac.ssid.set") });
  rename.disabled = macSetup.running || !setupOk;
  rename.addEventListener("click", () => openMacRename(name));
  const rows = [
    cell(el("label", { class: "cell-label", text: t("mac.tether.switch") }), enabled, t("mac.tether.switchHelp")),
    macStateRow(tone, t(`mac.net.${network}`), I18N.en[`mac.tstate.${tt.state}`] ? t(`mac.tstate.${tt.state}`) : tt.state, side),
    // No "keep this network" pin here: beside the switch above it read as the same thing twice
    // (2026-10-20). The API keeps `pin` for the CLI.
    cell(t("mac.ssid.label"), [el("span", { class: name ? "mac-ssid" : "mac-ssid empty", text: name || t("mac.ssid.none") }), rename]),
  ];
  let notice = null;
  // Before setup the card above says what to do; the router's own setup hint would only repeat it.
  if (tt.hint && tt.state !== "pinned" && setupOk) {
    const known = MAC_HINT_STATES.has(tt.state);
    notice = el("div", { class: "notice warn mac-hint", role: "status" }, [
      el("strong", { text: t(known ? `mac.tstate.${tt.state}` : "mac.hint.title") }),
      el("span", { text: known ? t(`mac.hint.${tt.state}`) : tt.hint }),
    ]);
  }
  return el("section", { class: "mod-card mac-card", "aria-labelledby": "mac-tether-title" }, [
    el("div", { class: "mod-card-head" }, [el("h2", { id: "mac-tether-title", text: t("mac.tether.title") }), hint(t("mac.tether.blurb"))]),
    notice,
    el("div", { class: "group" }, rows),
    el("p", { class: "group-footer", text: t(macIsMac() ? "mac.tether.help" : "mac.tether.helpWin") }),
    macDetails("tether", [
      [t("mac.d.state"), tt.state],
      [t("mac.d.network"), tt.network],
      [t("mac.d.probe"), tt.lastProbe ? `${tt.lastProbe.ok ? "ok" : "failed"} · ${tt.lastProbe.network} · ${macTime(tt.lastProbe.at)}` : "—"],
      [t("mac.d.switch"), tt.lastSwitch ? `${tt.lastSwitch.to} · ${tt.lastSwitch.ok ? "ok" : "failed"} · ${tt.lastSwitch.reason}` : "—"],
      tt.hint ? [t("mac.d.hint"), tt.hint] : null,
    ]),
  ]);
}
function macEmpty(title, body) {
  return el("div", { class: "offline-state", role: "status" }, [
    el("div", { class: "offline-icon direct" }, [svgIcon("0 0 20 20", ["M3.5 13V5.6c0-.9.7-1.6 1.6-1.6h9.8c.9 0 1.6.7 1.6 1.6V13", "M1.8 15.8h16.4"])]),
    el("h2", { text: title }),
    el("p", { text: body }),
  ]);
}
/** What the page was last drawn from: an unchanged refresh leaves the controls alone, so a click
 *  that lands while it arrives is not lost to a button replaced under the pointer. */
let macDrawn = "";
function renderMac() {
  const root = $("#mac-content");
  const drawn = JSON.stringify([macPower, macError, macSetup, macSetupWatched, CURRENT_LANG]);
  if (drawn === macDrawn && root.childElementCount) return;
  macDrawn = drawn;
  if (!macPower) {
    if (macError === "unavailable") root.replaceChildren(macEmpty(t("mac.unavailable.title"), t("mac.unavailable.body")));
    else if (macError) root.replaceChildren(section(null, [el("div", { class: "cell-note bad-text", text: `${t("common.loadFailed")} ${macError}` })]));
    return;
  }
  const a = macPower.awake;
  if (a.setup === "unsupported") {
    root.replaceChildren(macEmpty(t("mac.unsupported.title"), t("mac.unsupported.body")));
    return;
  }
  const setupOk = a.setup === "ok";
  // The password/setup card is macOS's alone: Windows holds sleep and edits the power plan as the
  // signed-in user, so its setup() always answers "ok" and this card never appears there (a Linux
  // power status has no backend at all and shows the unsupported state above).
  const needsSetup = !setupOk && macIsMac();
  const cards = el("div", { class: `mac-cards${needsSetup ? " mac-locked" : ""}` }, [macAwakeCard(a), macTetherCard(macPower.tether, setupOk)]);
  if (needsSetup) cards.setAttribute("inert", "");
  // Once set up, a later run (a new hotspot name) reports here, above the cards.
  const note = setupOk && macSetupWatched ? macSetupNote() : null;
  modRedraw(root, [
    needsSetup ? macSetupCard(macPower) : null,
    note ? el("div", { class: "mac-run" }, [note]) : null,
    cards,
  ]);
}
setInterval(() => { if (!macBusy && !macSetup.running) void refreshMac(); }, 5000);

// ---- Model links --------------------------------------------------------------------

function claudeSelect(selected) {
  const select = el("select", {});
  for (const model of claudeModels) select.appendChild(selectOption(model.id, labelOf(model)));
  select.value = selected || claudeModels[0].id;
  return select;
}
function targetSelect(route) {
  const select = el("select", {});
  select.appendChild(selectOption("", t("slots.passthrough")));
  for (const group of groupedModels(currentConfig)) {
    const optgroup = el("optgroup", { label: group.name });
    for (const model of group.models) optgroup.appendChild(selectOption(JSON.stringify([group.name, model.id]), labelOf(model)));
    select.appendChild(optgroup);
  }
  select.value = route ? JSON.stringify([route.provider, route.model]) : "";
  return select;
}
function effortSelect(value, levels) {
  const select = el("select", {});
  for (const effort of levels) select.appendChild(selectOption(effort, effort));
  select.value = levels.includes(value) ? value : (levels.includes("high") ? "high" : levels[0]);
  return select;
}
function routeFromTarget(value) {
  if (!value) return null;
  try {
    const [provider, model] = JSON.parse(value);
    return provider && model ? { provider, model } : null;
  } catch { return null; }
}
// One mapping per row: the Claude model, what answers it, and its effort. On a narrow window the
// three stack, so each carries its own small label (hidden where the column heads show).
function slotRow(id, route) {
  const row = el("div", { class: "map-row" });
  const source = claudeSelect(id);
  const target = targetSelect(route);
  source.setAttribute("aria-label", t("slots.th.claude"));
  target.setAttribute("aria-label", t("slots.th.target"));
  const initialTarget = routeFromTarget(target.value);
  const effort = effortSelect(route && route.effort, initialTarget ? effortLevelsFor(initialTarget.provider, initialTarget.model) : ["high"]);
  effort.setAttribute("aria-label", t("slots.th.effort"));
  const effortCell = el("div", { class: "map-col map-effort" }, [el("span", { class: "map-label", text: t("slots.th.effort") }), effort]);
  const remove = el("button", { class: "icon-btn remove", type: "button", title: t("common.remove"), "aria-label": t("common.remove"), onclick: () => { row.remove(); updateSlotSummary(); scheduleSlotsSave(); } }, [svgIcon("0 0 20 20", ["M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4z", "M6.6 10h6.8"])]);
  function sync() {
    const selected = routeFromTarget(target.value);
    const levels = selected ? effortLevelsFor(selected.provider, selected.model) : [];
    const supported = levels.length > 0;
    const prior = effort.value;
    effort.replaceChildren(...levels.map((level) => selectOption(level, level)));
    if (supported) effort.value = levels.includes(prior) ? prior : (levels.includes("high") ? "high" : levels[0]);
    effort.disabled = !supported;
    effortCell.classList.toggle("muted-cell", !supported);
    if (!supported) {
      effortCell.dataset.empty = t("common.notAvailable");
      effortCell.title = t("slots.noEffort");
    } else {
      delete effortCell.dataset.empty;
      effortCell.removeAttribute("title");
    }
    updateSlotSummary();
  }
  target.addEventListener("change", () => { sync(); scheduleSlotsSave(); });
  source.addEventListener("change", () => { updateSlotSummary(); scheduleSlotsSave(); });
  effort.addEventListener("change", scheduleSlotsSave);
  row.append(
    el("div", { class: "map-col map-source" }, [el("span", { class: "map-label", text: t("slots.th.claude") }), source]),
    el("span", { class: "map-arrow", "aria-hidden": "true", text: "→" }),
    el("div", { class: "map-col map-target" }, [el("span", { class: "map-label", text: t("slots.th.target") }), target]),
    effortCell,
    el("div", { class: "map-remove" }, [remove]),
  );
  row._get = () => ({ id: source.value, route: routeFromTarget(target.value), effort: effort.value });
  sync();
  return row;
}
async function loadSlots() {
  slotsLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    const rows = $("#slots-list");
    rows.replaceChildren();
    const routes = currentConfig.routes || {};
    const ids = [...claudeModels.map((model) => model.id), ...Object.keys(routes).filter((id) => !claudeModels.some((model) => model.id === id))];
    for (const id of ids) rows.appendChild(slotRow(id, routes[id]));
    updateSlotSummary();
  } catch (error) {
    toast(t("common.loadFailed"), true, error.message);
  }
}
$("#slots-add").addEventListener("click", () => {
  if (!currentConfig) return;
  $("#slots-list").appendChild(slotRow(claudeModels[0].id, null));
  updateSlotSummary();
});
function allKnownModelIds(config) { return new Set(groupedModels(config).flatMap((group) => group.models.map((model) => model.id))); }
// Which providers carry this exact id. One is what lets the router route it with no rule at all;
// two is the ambiguity it refuses to guess through, and the only case a rule is still needed.
function providersOffering(config, id) { return groupedModels(config).filter((group) => group.models.some((model) => model.id === id)).map((group) => group.name); }
// Whose entry this is. A `direct` rule used to answer it, but since 2026-09-19 a model routes by
// the provider that declares it and most models have no rule at all — so the answer is the
// providers, with the rule kept only for the ambiguity they cannot settle: two offering one id.
function pickerOwner(config, id) {
  const offering = providersOffering(config, id);
  if (offering.length < 2) return offering[0];
  const rule = (config.direct || []).filter((entry) => id.startsWith(entry.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return rule && offering.includes(rule.provider) ? rule.provider : offering[0];
}
/**
 * The picker entries belonging to every provider but the one being saved — the ones no checkbox on
 * this form can speak for, and which the rebuild must therefore be told to keep.
 *
 * Asking `direct` who owned them dropped all of them: the rules stopped being written in 2026-09-19
 * and only the legacy `gpt-` prefix still matched anything, so one save of any provider emptied the
 * picker of every non-GPT model (measured 2026-09-22 — deepseek and five more went that way).
 */
function pickerSelectionsExcept(config, providerName) {
  return ((config.cli && config.cli.extraModels) || [])
    .filter((entry) => entry.model !== null && entry.model !== undefined)
    // The window is part of the entry; rebuilding without it reset every other provider's.
    .map((entry) => ({ id: entry.model, name: entry.name, contextWindow: entry.contextWindow, provider: pickerOwner(config, entry.model) }))
    .filter((entry) => entry.provider && entry.provider !== providerName);
}
function applyPickerSelections(next, selections) {
  const known = allKnownModelIds(next);
  // An entry no provider offers any more has no checkbox — the list is built from the providers —
  // so keeping it here left removed models in the app picker forever, twice over once the same id
  // had been written twice. Orphans go, the rest is deduplicated by model id, and the direct rules
  // that served only an orphan go with it. A prefix rule that is not a model id (the legacy gpt-
  // one) is not an orphan and stays.
  const currentExtras = (next.cli && next.cli.extraModels) || [];
  const orphans = new Set(currentExtras.filter((entry) => entry.model && !known.has(entry.model)).map((entry) => entry.model));
  const selected = selections.filter((entry) => entry.id && entry.provider && known.has(entry.id));
  const extras = new Map();
  const direct = new Map();
  for (const entry of selected) {
    // Without this the rebuild would drop the window on every checkbox click.
    extras.set(entry.id, { model: entry.id, name: entry.name || entry.id, ...(Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}) });
    // A rule per ticked model is no longer what makes it route: since 2026-09-19 the router sends a
    // model to the one provider whose own `models` list carries it (routing.ts, "declared models").
    // Writing one anyway restated the same fact in a second place and piled up — one config reached
    // eighteen. It is still written for the case the router deliberately refuses to guess: an id
    // that MORE THAN ONE provider offers, where only the operator knows which deal is meant. Keep
    // this condition and the router's in step; the router is the one that decides.
    if (providersOffering(next, entry.id).length > 1) direct.set(entry.id, { prefix: entry.id, provider: entry.provider });
  }
  next.cli = { ...(next.cli || {}), extraModels: [...extras.values()] };
  // A rule survives when it is not a model id at all (the legacy `gpt-` prefix), or when it names an
  // id two providers offer, which the router will not resolve on its own. Dropping that second kind
  // because the model happens not to be ticked in the picker would stop it routing: the config here
  // has `deepseek-v4-pro` on a direct mapping and on OpenCode Go, and it is in no picker list.
  // An orphan goes either way — no provider offers it, and nothing in the interface can uncheck it.
  const preservedDirect = (next.direct || []).filter((rule) =>
    !orphans.has(rule.prefix) && (!known.has(rule.prefix) || providersOffering(next, rule.prefix).length > 1));
  const byPrefix = new Map(preservedDirect.map((rule) => [rule.prefix, rule]));
  for (const [prefix, rule] of direct) if (!byPrefix.has(prefix)) byPrefix.set(prefix, rule);
  next.direct = [...byPrefix.values()];
  // A legacy gpt- prefix rule is intentionally retained by the filter above.
  return next;
}
function updateSlotSummary() {
  const summaries = $all("#slots-list .map-row").map((row) => row._get()).filter((item) => item.route).slice(0, 3).map((item) => {
    const source = claudeModels.find((model) => model.id === item.id);
    const group = groupedModels(currentConfig).find((itemGroup) => itemGroup.name === item.route.provider);
    const target = group && group.models.find((model) => model.id === item.route.model);
    return `${labelOf(source || { id: item.id })} → ${labelOf(target || { id: item.route.model })}${effortLevelsFor(item.route.provider, item.route.model).length ? ` (${item.effort})` : ""}`;
  });
  $("#slots-summary").textContent = summaries.length ? summaries.join(" · ") : t("slots.noChanges");
}
// Changes save themselves (debounced); there is no Save button. `slotsStatus` shows saving/saved/error.
let slotsSaveTimer = null;
let slotsSaving = false;
function slotsStatus(text, isError) {
  const box = $("#slots-status");
  box.textContent = text;
  box.classList.toggle("bad-text", Boolean(isError));
}
function scheduleSlotsSave() {
  if (!currentConfig || !slotsLoaded) return;
  clearTimeout(slotsSaveTimer);
  slotsStatus(t("slots.saving"));
  slotsSaveTimer = setTimeout(() => void saveSlots(), 500);
}
async function saveSlots() {
  if (!currentConfig || slotsSaving) return;
  slotsSaving = true;
  const next = clone(await latestConfig());
  const routes = {};
  const seen = new Set();
  for (const row of $all("#slots-list .map-row")) {
    const item = row._get();
    if (seen.has(item.id)) { slotsStatus(t("slots.duplicate"), true); slotsSaving = false; return; }
    seen.add(item.id);
    if (item.route) routes[item.id] = { ...item.route, ...(effortLevelsFor(item.route.provider, item.route.model).length ? { effort: item.effort } : {}) };
  }
  next.routes = routes;
  try {
    await configRequest(next);
    currentConfig = next;
    slotsStatus(t("slots.saved"));
    updateSlotSummary();
  } catch (error) {
    slotsStatus(`${t("common.saveFailed")} ${error.message}`, true);
  } finally {
    slotsSaving = false;
  }
}

// ---- Providers ----------------------------------------------------------------------

async function probeProvider(name, provider, onComplete, savedName) {
  probeStates.set(name, { pending: true });
  renderHealthProviders();
  try {
    const headers = provider.headers || {};
    // The saved provider whose key pool the router should resolve the check's key from. `name` is a
    // UI state key and can be temporary (a draft), so it is never sent.
    const providerName = savedName || (name && !String(name).startsWith("__new_") ? name : undefined);
    // A provider whose keys moved into `credentials[]` keeps no auth header in `headers`, so the
    // probe borrows the first usable key's header; otherwise "연결 확인" tested an anonymous request.
    // A named provider needs no borrow: the router resolves the key from its own copy, and the key
    // stays out of the request the page builds.
    const credentialHeader = providerName || authHeaderName(headers) ? null : credentialAuthHeader(provider);
    const body = provider.type === "anthropic"
      ? { type: "anthropic", auth: provider.auth, ...(provider.auth === "api-key" && provider.apiKey ? { apiKey: provider.apiKey } : {}) }
      : provider.type === "google"
      ? { type: "google", auth: provider.auth, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}), ...(provider.url ? { url: provider.url } : {}) }
      : provider.type === "grok"
      ? { type: "grok", ...Object.fromEntries(["home", "cli", "url", "clientVersion"].filter((key) => provider[key]).map((key) => [key, provider[key]])) }
      : {
        type: provider.type,
        url: provider.url,
        // With several keys the key lives in `credentials`, not in `headers` (adding one migrates
        // it), so the router resolves the check's key from its own copy of the provider.
        ...(providerName ? { name: providerName } : {}),
        headers: credentialHeader ? { ...headers, [credentialHeader.name]: credentialHeader.value } : headers,
        modelsUrl: provider.modelsUrl || (provider.preset && presetById(provider.preset) && presetById(provider.preset).modelsUrl),
        modelsAuthHeader: provider.modelsAuthHeader || (provider.preset && presetById(provider.preset) && presetById(provider.preset).modelsAuthHeader),
        // The router reads the preset's fallback list to tag each discovered model with the wire it
        // speaks, since /models reports ids alone and one plan can serve several wires.
        preset: provider.preset,
        // Without a preset the provider's own first model is the only id known to exist there.
        probeModel: provider.probeModel || (provider.preset && presetById(provider.preset) && (presetById(provider.preset).fallbackModels || [])[0] && presetById(provider.preset).fallbackModels[0].id) || (modelsOf(provider)[0] && modelsOf(provider)[0].id),
        // Some vendors refuse a request without it rather than merely losing the cache, so a test
        // that leaves it out reports a broken provider that works perfectly.
        sessionHeader: provider.sessionHeader || (provider.preset && presetById(provider.preset) && presetById(provider.preset).sessionHeader),
        wire: provider.wire,
      };
    const result = await api("/api/providers/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    probeStates.set(name, { ...result, at: Date.now() });
    onComplete && onComplete(result);
    return result;
  } catch (error) {
    const unavailable = error.status === 404;
    const result = { ok: false, auth: unavailable ? "unknown" : "unreachable", models: [], error: unavailable ? t("providers.apiSoon") : error.message, unavailable };
    probeStates.set(name, { ...result, at: Date.now() });
    onComplete && onComplete(result);
    return result;
  } finally {
    renderHealthProviders();
  }
}
// ---- Capability measurement ---------------------------------------------------------
//
// A model's wire and its effort ladder are measured by asking it, because a vendor's `/models`
// reports ids and nothing else. That takes several small requests per model, far too long to hold a
// save behind, so the save returns at once and this runs after it and settles the config when it
// finishes. Provider name → { state, done, total }, for the line the detail view shows meanwhile.
const measureStates = new Map();

/** What the operator wants to know from a finished job: what was settled, and what would not answer. */
function measureSummary(results) {
  const measured = results.filter((entry) => entry.wire);
  if (measured.length === 0) return "";
  const failed = results.length - measured.length;
  const parts = measured.map((entry) => `${entry.id} → ${entry.wire}${entry.effortLevels ? ` (${entry.effortLevels.length ? entry.effortLevels.join("/") : t("providers.effortNone")})` : ""}`);
  return failed > 0 ? `${parts.join(", ")} · +${failed}` : parts.join(", ");
}

/**
 * Measure the models of one provider, in the background, and show the config the result settled.
 *
 * Only models missing a wire or a ladder are sent: one the operator set is their decision, and the
 * router will not overwrite it either, so measuring it again would spend requests to change nothing.
 */
async function startMeasurement(providerName, provider) {
  if (!provider || (provider.type !== "openai-compatible" && provider.type !== "anthropic-compatible")) return;
  const models = modelsOf(provider).filter((model) => !model.wire || !model.effortLevels).map((model) => model.id);
  if (models.length === 0) return;
  let jobId;
  try {
    const started = await api("/api/providers/measure", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: providerName, models }),
    });
    jobId = started.jobId;
    measureStates.set(providerName, { state: "running", done: 0, total: started.total });
    renderProviderWorkspace();
  } catch { return; } // The router is older than this screen, or said no: the save itself stands.
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const job = await api(`/api/providers/measure/${jobId}`);
      measureStates.set(providerName, { state: job.state, done: job.done, total: job.total });
      renderProviderWorkspace();
      if (job.state === "running") continue;
      measureStates.delete(providerName);
      if (job.state === "failed") { toast(t("measure.failed"), true, job.error); renderProviderWorkspace(); return; }
      const results = job.results || [];
      // A model the plan refuses is not merely unmeasured: no wire will ever answer for it, so
      // saying so once here is the only chance the operator gets before a session fails on it.
      // Measured 2026-09-22: OpenCode answers every `-free` model with 403 FreeTierError.
      const barred = results.filter((entry) => typeof entry.error === "string" && entry.error.startsWith("not-entitled"));
      if (barred.length > 0) toast(t("measure.notEntitled", { models: barred.map((entry) => entry.id).join(", ") }), true);
      const summary = measureSummary(results);
      // An auth failure is reported as itself: it says nothing about any model, and leaving it as
      // "nothing was measured" would send the operator looking at the wrong thing.
      const refused = results.some((entry) => entry.error === "auth");
      // The barred models already had their own line; do not also call the round a failure when
      // every other model measured fine.
      if (summary || barred.length === 0) toast(summary ? t("measure.done", { summary }) : refused ? t("measure.authFailed") : t("measure.nothing"), !summary);
      await loadProviders();
      return;
    }
  } catch (error) {
    measureStates.delete(providerName);
    toast(t("measure.failed"), true, error.message);
    renderProviderWorkspace();
  }
}

let selectedProviderName = null;
let providerDetailTab = "overview";
let providerSearch = "";
let providerDetailGeneration = 0;

function providerKind(name, provider) {
  const preset = provider.preset && presetById(provider.preset);
  if (provider.type === "chatgpt") return t("providers.chatgpt");
  if (provider.type === "google") return `${t("providers.google")} · ${provider.auth === "antigravity" ? t("providers.googleAntigravity") : t("providers.apiKey")}`;
  if (provider.type === "grok") return t("providers.grok");
  if (provider.type === "anthropic") return provider.auth === "claude-code"
    ? `${t("providers.anthropic")} · ${provider.accountPool ? t("providers.rotationOn") : t("providers.rotationOff")}`
    : `${t("providers.anthropic")} · ${t("providers.apiKey")}`;
  if (preset) return preset.name;
  try { return new URL(provider.url).host; } catch { return provider.type || name; }
}

function providerRailItem(name, provider) {
  const selected = name === selectedProviderName;
  const button = el("button", {
    class: `provider-rail-item${selected ? " selected" : ""}`,
    type: "button",
    role: "option",
    "aria-selected": String(selected),
  }, [
    el("span", { class: "provider-rail-copy" }, [
      el("strong", { text: name }),
      el("span", { text: t("providers.modelsCountShort", { count: modelsOf(provider).length }) }),
    ]),
    providerState(name, provider),
  ]);
  button.addEventListener("click", () => openProvider(name, provider));
  return button;
}

/**
 * Show one provider's page, from its list or from the Status screen. A narrow window shows the list
 * and the page one at a time (`show-detail`), so this is also the "push" to the page.
 */
function openProvider(name, provider) {
  selectedProviderName = name;
  providerDetailTab = provider.type === "anthropic" && provider.auth === "claude-code" ? "accounts" : "overview";
  $("#view-providers").classList.add("show-detail");
  if (!$("#view-providers").classList.contains("active")) showView("providers");
  if (currentConfig && currentConfig.providers && currentConfig.providers[name]) renderProviderWorkspace();
  window.scrollTo(0, 0);
}
function closeProviderDetail() {
  $("#view-providers").classList.remove("show-detail");
  window.scrollTo(0, 0);
}

function renderProviderRail() {
  const list = $("#providers-list");
  const entries = Object.entries((currentConfig && currentConfig.providers) || {});
  const query = providerSearch.trim().toLowerCase();
  const visible = entries.filter(([name, provider]) => !query || name.toLowerCase().includes(query) || providerKind(name, provider).toLowerCase().includes(query));
  list.replaceChildren(...visible.map(([name, provider]) => providerRailItem(name, provider)));
  if (!entries.length) list.appendChild(el("div", { class: "provider-rail-empty", text: t("providers.empty") }));
  else if (!visible.length) list.appendChild(el("div", { class: "provider-rail-empty", text: t("providers.noSelection") }));
}

async function removeProvider(name, provider) {
  if (!confirm(t("providers.removeConfirm", { name }))) return;
  const next = clone(await latestConfig());
  delete next.providers[name];
  next.routes = Object.fromEntries(Object.entries(next.routes || {}).filter(([, route]) => route.provider !== name));
  next.direct = (next.direct || []).filter((rule) => rule.provider !== name);
  next.cli.extraModels = (next.cli.extraModels || []).filter((entry) => !modelsOf(provider).some((model) => model.id === entry.model));
  try {
    await configRequest(next);
    currentConfig = next;
    selectedProviderName = Object.keys(next.providers)[0] || null;
    providerDetailTab = "overview";
    slotsLoaded = false;
    clientsLoaded = false;
    closeProviderDetail();
    renderProviderWorkspace();
    toast(t("common.saved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

function providerTabs(name, provider) {
  const tabs = [{ id: "overview", label: t("providers.overview") }];
  if ((provider.type === "anthropic" && provider.auth === "claude-code") || provider.type === "chatgpt" || (provider.type === "google" && provider.auth === "antigravity") || isKeyBasedProvider(provider)) tabs.push({ id: "accounts", label: t("providers.accounts") });
  tabs.push({ id: "models", label: t("providers.modelsTab") });
  return el("div", { class: "provider-tabs", role: "tablist" }, tabs.map((tab) => {
    const button = el("button", { class: providerDetailTab === tab.id ? "active" : "", type: "button", role: "tab", "aria-selected": String(providerDetailTab === tab.id), text: tab.label });
    button.addEventListener("click", () => { providerDetailTab = tab.id; renderProviderDetail(); });
    return button;
  }));
}

function providerOverview(name, provider) {
  const state = stateFor(name);
  const live = status && status.providers && status.providers[name];
  const connection = section(t("providers.connection"), [
    // The kind is already under the page title; this row is only the verdict and what to do about it.
    cell(t("health.connection"), providerState(name, provider), [
      state && !state.ok && state.error ? el("span", { class: "cell-sub bad-text", text: shortError(state.error), title: state.error }) : null,
      live && live.needsLogin && provider.type === "chatgpt" ? el("div", { class: "cell-actions" }, [chatgptLoginButton(renderProviderDetail)]) : null,
    ]),
  ]);
  const models = modelsOf(provider);
  const measuring = measureStates.get(name);
  const running = measuring && measuring.state === "running";
  // Names only, as one quiet line: the Models tab is where each one is listed and edited.
  const modelSummary = section(t("providers.selectedModels"), [
    models.length ? el("div", { class: "cell-note" }, [el("span", { class: "cell-label", text: models.map(labelOf).join(", ") })]) : el("div", { class: "cell-note", text: t("providers.noModels") }),
    running ? el("div", { class: "cell-note", text: t("measure.running", { done: measuring.done, total: measuring.total }) }) : null,
  ], running ? t("measure.help") : null);
  const quota = quotaLine(name);
  return el("div", { class: "provider-panel" }, [
    connection,
    quota ? section(null, [cell(t("providers.usage"), el("span", { text: quota }))]) : null,
    modelSummary,
  ]);
}

function providerModelsPanel(name, provider) {
  const models = modelsOf(provider);
  const edit = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit"), onclick: () => openProviderForm({ name, provider }) });
  return el("div", { class: "provider-panel" }, [
    section(t("providers.selectedModels"), models.length
      ? models.map((model) => cell(labelOf(model), modelEffortTag(model) ? el("span", { class: `model-effort-tag ${model.effortLevels.length ? "has-effort" : "no-effort"}`, text: modelEffortTag(model) }) : null, el("span", { class: "cell-sub mono", text: model.id }), "provider-model-row"))
      : [el("div", { class: "cell-note", text: t("providers.noModels") })], t("providers.modelsHelp"), edit),
  ]);
}

async function saveAnthropicRotation(name, provider, enabled, control, message) {
  control.disabled = true;
  message.textContent = t("providers.rotationSaving");
  const next = clone(await latestConfig());
  if (enabled) next.providers[name].accountPool = true;
  else delete next.providers[name].accountPool;
  try {
    await configRequest(next);
    currentConfig = next;
    slotsLoaded = false;
    clientsLoaded = false;
    renderProviderWorkspace();
    toast(t("providers.rotationSaved"));
  } catch (error) {
    control.checked = !enabled;
    message.textContent = "";
    toast(t("common.saveFailed"), true, error.message);
  } finally { control.disabled = false; }
}

/** The current login is named by the router in English; everything else carries the user's own label. */
function claudeAccountLabel(account) {
  return account.id === "current" ? t("providers.anthropicCurrent") : account.label;
}

/** "5h 14% · weekly 10%" under a Claude account, or nothing while its usage is unknown. */
function claudeQuotaNode(account) {
  const text = chatgptQuotaText(account && account.quota);
  return text ? el("p", { class: "small account-quota", text }) : null;
}

/** "Use first" for an account the pool does not lead with; `null` hands first place back to the current login. */
function claudePreferButton(name, id, disabled) {
  const button = el("button", { class: "btn secondary compact", type: "button", text: t("providers.preferAction") });
  button.disabled = disabled;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api("/api/claude-accounts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preferred: id }) }); await refreshClaudeAccountPanel(name); }
    catch (error) { button.disabled = false; toast(t("common.actionFailed"), true, error.message); }
  });
  return button;
}

function renderClaudeAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  // Rows follow the order the router tries them in: the preferred account, else the current login, first.
  const stored = Array.isArray(data.accounts) ? [...data.accounts] : [];
  const preferredIndex = stored.findIndex((account) => account.preferred);
  if (preferredIndex > 0) stored.unshift(...stored.splice(preferredIndex, 1));
  const leader = preferredIndex >= 0 ? stored[0].id : data.current ? "current" : stored[0] && stored[0].id;
  const choosable = (data.current ? 1 : 0) + stored.length > 1;
  const firstBadge = (id) => (choosable && id === leader ? el("span", { class: "badge first", text: t("providers.preferBadge") }) : null);
  const rows = [];
  const currentRow = data.current ? el("article", { class: "cell account-card current" }, [
    el("div", { class: "cell-text account-card-copy" }, [
      el("strong", { text: data.current.label }), el("span", { class: "small", text: anthropicSourceText(data.current.source) }), claudeQuotaNode(data.current), hint(t("providers.currentAccountHelp")),
      choosable && leader !== "current" ? el("div", { class: "account-card-actions" }, [claudePreferButton(name, null, false)]) : null,
    ]),
    el("div", { class: "account-card-badges" }, [firstBadge("current"), el("span", { class: "badge ok", text: t("providers.anthropicCurrent") })]),
  ]) : null;
  if (currentRow && preferredIndex < 0) rows.push(currentRow);
  for (const account of stored) {
    const unavailable = account.needsReauth || account.expiresAt <= Date.now();
    const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
    rename.addEventListener("click", async () => {
      const label = prompt(t("providers.anthropicRenamePrompt"), account.label);
      if (!label || !label.trim() || label.trim() === account.label) return;
      try { await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) }); await refreshClaudeAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
    remove.addEventListener("click", async () => {
      if (!confirm(t("providers.anthropicRemoveConfirm", { name: account.label }))) return;
      try { await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshClaudeAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    const actions = [rename, remove];
    if (choosable && account.id !== leader) actions.unshift(claudePreferButton(name, account.id, unavailable));
    if (unavailable) {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => openClaudeAccountConsent(name));
      actions.unshift(reauth);
    }
    rows.push(el("article", { class: "cell account-card" }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }), account.email && account.email !== account.label ? el("span", { class: "small", text: account.email }) : null, claudeQuotaNode(account), hint(t("providers.addedAccountHelp")),
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, [firstBadge(account.id), el("span", { class: `badge ${unavailable ? "bad" : "ok"}`, text: unavailable ? t("providers.anthropicReauth") : t("pool.ready") })]),
    ]));
    if (currentRow && rows.length === 1 && preferredIndex >= 0) rows.push(currentRow);
  }
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.anthropicNoAccounts") })]));
  const preferNote = $("#claude-account-prefer");
  if (preferNote) preferNote.hidden = !choosable;
  const count = (data.current ? 1 : 0) + stored.length;
  const countNode = $("#claude-account-count");
  if (countNode) countNode.textContent = t("providers.accountCount", { count });
}

async function refreshClaudeAccountPanel(name) {
  const target = $("#claude-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { renderClaudeAccountRows(target, await api("/api/claude-accounts"), name, generation); }
  catch (error) { if (generation === providerDetailGeneration) target.replaceChildren(el("div", { class: "bad-text small", text: error.message })); }
}

function anthropicAccountsPanel(name, provider) {
  const rotation = el("input", { type: "checkbox", checked: Boolean(provider.accountPool) });
  const rotationMessage = el("span", { class: "small" });
  rotation.addEventListener("change", () => void saveAnthropicRotation(name, provider, rotation.checked, rotation, rotationMessage));
  const add = el("button", { class: "cell-button", type: "button", text: t("providers.addClaudeAccount") });
  add.addEventListener("click", () => openClaudeAccountConsent(name));
  const removeAll = el("button", { class: "cell-button destructive", type: "button", text: t("providers.anthropicLogoutAll") });
  removeAll.addEventListener("click", async () => {
    if (!confirm(t("providers.anthropicLogoutAllConfirm"))) return;
    try { await api("/api/claude-logout", { method: "POST" }); await refreshClaudeAccountPanel(name); }
    catch (error) { toast(t("common.actionFailed"), true, error.message); }
  });
  rotation.setAttribute("role", "switch");
  rotation.setAttribute("aria-label", t("providers.anthropicPool"));
  const rows = el("div", { id: "claude-account-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  // The rotation switch first (it decides whether added accounts are used at all), then the
  // accounts with "Add" at the end of their list, then the one destructive act on its own.
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "group" }, [cell(t("providers.anthropicPool"), el("label", { class: "switch" }, [rotation, el("span")]), [t("providers.accountPoolSubtitle"), rotationMessage])]),
      !provider.accountPool ? el("div", { class: "group-footer notice" }, [el("strong", { text: t("providers.rotationOff") }), el("span", { text: t("providers.rotationRequired") })]) : null,
    ]),
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.accountPoolTitle") }), el("span", { id: "claude-account-count", class: "small", text: t("providers.accountCount", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      el("p", { class: "group-footer", text: t("providers.accountCountHelp") }),
      el("p", { id: "claude-account-prefer", class: "group-footer", text: t("providers.preferHelp"), hidden: "" }),
    ]),
    section(t("providers.dangerZone"), [removeAll], t("providers.anthropicLogoutAllConfirm")),
  ]);
  queueMicrotask(() => void refreshClaudeAccountPanel(name));
  return panel;
}

/** "5h 42%", "weekly 100% · resets 14:05" — the reset only matters once a window is full. */
function chatgptQuotaText(quota) {
  const limits = quota && quota.rate_limits;
  if (!limits) return "";
  const windowName = (w) => {
    const minutes = w.window_minutes;
    if (!minutes) return "";
    if (minutes >= 7 * 24 * 60) return t("quota.windowWeek");
    if (minutes === 300) return t("quota.window5h");
    return t("quota.windowHours", { hours: Math.round(minutes / 60) });
  };
  return [limits.primary, limits.secondary].filter((w) => w && typeof w.used_percent === "number").map((w) => {
    const line = t("quota.line", { window: windowName(w), percent: Math.round(w.used_percent) }).trim();
    if (w.used_percent < 100) return line;
    const at = typeof w.reset_after_seconds === "number" ? Date.now() + w.reset_after_seconds * 1000 : typeof w.reset_at === "number" ? w.reset_at * 1000 : null;
    return at ? `${line} · ${t("quota.resetAt", { time: new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}` : line;
  }).join(" · ");
}

/** A wait people read at a glance: "1시간 29분", "12분", "40초". */
function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s >= 3600) return t("time.hoursMinutes", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  if (s >= 60) return t("time.minutes", { m: Math.ceil(s / 60) });
  return t("time.seconds", { s });
}

function chatgptStateBadge(account) {
  if (account.state === "paused") return el("span", { class: "badge", text: t("providers.chatgptPaused") });
  if (account.state === "needs-login" || account.state === "quarantined") return el("span", { class: "badge bad", text: t("providers.anthropicReauth") });
  if (account.state === "needs-verification") return el("span", { class: "badge warn", text: t("providers.googleVerifyNeeded") });
  if (account.state === "cooling") return el("span", { class: "badge warn", text: t("pool.coolingFor", { duration: durationText(account.cooldownSeconds) }) });
  return el("span", { class: "badge ok", text: account.active ? t("providers.chatgptInUse") : t("providers.chatgptStandby") });
}

async function patchChatgptAccount(name, id, change) {
  try {
    await api(`/api/chatgpt-accounts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
    await refreshChatgptAccountPanel(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}

function renderChatgptAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const rows = accounts.map((account) => {
    const own = account.source !== "codex";
    const actions = [];
    if (account.state === "needs-login" || account.state === "quarantined") {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => void startChatgptLogin(() => void refreshChatgptAccountPanel(name), true));
      if (own) actions.push(reauth);
    }
    if (account.state === "cooling") {
      const now = el("button", { class: "btn secondary compact", type: "button", text: t("providers.chatgptClearCooldown") });
      now.addEventListener("click", () => void patchChatgptAccount(name, account.id, { clearCooldown: true }));
      actions.push(now);
    }
    if (own) {
      const pause = el("button", { class: "btn secondary compact", type: "button", text: account.paused ? t("providers.chatgptResume") : t("providers.chatgptPause") });
      pause.addEventListener("click", () => void patchChatgptAccount(name, account.id, { paused: !account.paused }));
      const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
      rename.addEventListener("click", () => {
        const label = prompt(t("providers.anthropicRenamePrompt"), account.label);
        if (!label || !label.trim() || label.trim() === account.label) return;
        void patchChatgptAccount(name, account.id, { label });
      });
      const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
      remove.addEventListener("click", async () => {
        if (!confirm(t("providers.chatgptRemoveConfirm", { name: account.label }))) return;
        try { await api(`/api/chatgpt-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshChatgptAccountPanel(name); }
        catch (error) { toast(t("common.actionFailed"), true, error.message); }
      });
      actions.push(pause, rename, remove);
    }
    const quota = chatgptQuotaText(account.quota);
    const detail = [account.email && account.email !== account.label ? account.email : null, account.planType || null].filter(Boolean).join(" · ");
    const help = account.state === "needs-login" || account.state === "quarantined" ? t("providers.chatgptReauthHelp") : own ? t("providers.chatgptOwnHelp") : t("providers.chatgptCodexHelp");
    return el("article", { class: `cell account-card${account.active ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }),
        detail ? el("span", { class: "small", text: detail }) : null,
        quota ? el("p", { class: "small account-quota", text: quota }) : null,
        hint(help),
        actions.length ? el("div", { class: "account-card-actions" }, actions) : null,
      ]),
      el("div", { class: "account-card-badges" }, [chatgptStateBadge(account)]),
    ]);
  });
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.chatgptNoAccounts") })]));
  const countNode = $("#chatgpt-account-count");
  if (countNode) countNode.textContent = t("providers.chatgptAccountCount", { count: accounts.length });
}

let googleLoginBusy = false;
/**
 * The Antigravity sign-in. Google's terms name this use as a breach and suspended accounts for it,
 * so the warning is put in front of the user and the sign-in starts only on an explicit yes.
 */
async function startGoogleLogin(onChange) {
  if (googleLoginBusy) return false;
  if (!confirm(t("providers.googleWarning"))) return false;
  googleLoginBusy = true;
  onChange && onChange();
  try {
    const started = await api("/api/google-login", { method: "POST" });
    if (started.opened === false && started.url) toast(t("providers.googleOpenManually"), false, started.url);
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const login = await api("/api/google-login");
      if (login.running === false && login.ok === true) { toast(t("providers.googleAdded")); await refreshHealth(); return true; }
      if (login.running === false && login.ok === false) { toast(t("common.actionFailed"), true, login.error); return false; }
    }
    return false;
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
    return false;
  } finally {
    googleLoginBusy = false;
    onChange && onChange();
  }
}

async function patchGoogleAccount(name, id, change) {
  try {
    await api(`/api/google-accounts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
    await refreshGoogleAccountPanel(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}
async function recheckGoogleVerification(name, id) {
  try {
    const result = await api(`/api/google-accounts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ recheck: true }) });
    if (result.verification === "verified") toast(t("providers.googleVerified"));
    else if (result.verification === "still-required") toast(t("providers.googleStillUnverified"), true);
    else toast(t("providers.googleVerifyUnknown"), true);
    await refreshGoogleAccountPanel(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}

function renderGoogleAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const rows = accounts.map((account) => {
    const actions = [];
    if (account.state === "needs-login" || account.state === "quarantined") {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => void startGoogleLogin(() => void refreshGoogleAccountPanel(name)));
      actions.push(reauth);
    }
    // Only the person can finish Google's check, so the page opens in their browser; the account
    // answers again on the next turn after that.
    if (account.state === "needs-verification" && account.verifyUrl) {
      const link = el("a", { class: "btn secondary compact", href: account.verifyUrl, target: "_blank", rel: "noreferrer", text: t("providers.googleVerifyAction") });
      // Coming back to this window is the likeliest moment the page has been finished: ask then.
      link.addEventListener("click", () => window.addEventListener("focus", () => void recheckGoogleVerification(name, account.id), { once: true }));
      const recheck = el("button", { class: "btn secondary compact", type: "button", text: t("providers.googleRecheck") });
      recheck.addEventListener("click", () => { recheck.disabled = true; void recheckGoogleVerification(name, account.id); });
      actions.push(link, recheck);
    }
    if (account.state === "cooling") {
      const now = el("button", { class: "btn secondary compact", type: "button", text: t("providers.chatgptClearCooldown") });
      now.addEventListener("click", () => void patchGoogleAccount(name, account.id, { clearCooldown: true }));
      actions.push(now);
    }
    const pause = el("button", { class: "btn secondary compact", type: "button", text: account.paused ? t("providers.chatgptResume") : t("providers.chatgptPause") });
    pause.addEventListener("click", () => void patchGoogleAccount(name, account.id, { paused: !account.paused }));
    const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
    rename.addEventListener("click", () => {
      const label = prompt(t("providers.anthropicRenamePrompt"), account.label);
      if (!label || !label.trim() || label.trim() === account.label) return;
      void patchGoogleAccount(name, account.id, { label });
    });
    const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
    remove.addEventListener("click", async () => {
      if (!confirm(t("providers.googleRemoveConfirm", { name: account.label }))) return;
      try { await api(`/api/google-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshGoogleAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    actions.push(pause, rename, remove);
    const detail = [account.email && account.email !== account.label ? account.email : null, account.projectId ? t("providers.googleProject", { id: account.projectId }) : null].filter(Boolean).join(" · ");
    return el("article", { class: `cell account-card${account.active ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }),
        detail ? el("span", { class: "small", text: detail }) : null,
        hint(account.state === "needs-login" || account.state === "quarantined" ? t("providers.chatgptReauthHelp") : account.state === "needs-verification" ? t("providers.googleVerifyHelp") : t("providers.googleOwnHelp")),
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, [chatgptStateBadge(account)]),
    ]);
  });
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.googleNoAccounts") })]));
  const countNode = $("#google-account-count");
  if (countNode) countNode.textContent = t("providers.chatgptAccountCount", { count: accounts.length });
}

async function refreshGoogleAccountPanel(name) {
  const target = $("#google-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { renderGoogleAccountRows(target, await api(`/api/google-accounts?provider=${encodeURIComponent(name)}`), name, generation); }
  catch (error) { if (generation === providerDetailGeneration) target.replaceChildren(el("div", { class: "bad-text small", text: error.message })); }
}

function googleAccountsPanel(name) {
  const add = el("button", { class: "cell-button", type: "button", text: t("providers.addGoogleAccount") });
  add.disabled = googleLoginBusy;
  add.addEventListener("click", () => void startGoogleLogin(() => { renderProviderDetail(); void refreshGoogleAccountPanel(name); }));
  const rows = el("div", { id: "google-account-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.googleAccountsTitle") }), el("span", { id: "google-account-count", class: "small", text: t("providers.chatgptAccountCount", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      googleLoginBusy ? el("p", { class: "group-footer", text: t("providers.googleLoginWaiting") }) : null,
      el("p", { class: "group-footer", text: t("providers.googleAccountsSubtitle") }),
      el("div", { class: "group-footer notice" }, [el("strong", { text: t("providers.googleWarningShort") })]),
    ]),
  ]);
  queueMicrotask(() => void refreshGoogleAccountPanel(name));
  return panel;
}

async function refreshChatgptAccountPanel(name) {
  const target = $("#chatgpt-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { renderChatgptAccountRows(target, await api(`/api/chatgpt-accounts?provider=${encodeURIComponent(name)}`), name, generation); }
  catch (error) { if (generation === providerDetailGeneration) target.replaceChildren(el("div", { class: "bad-text small", text: error.message })); }
}

function chatgptAccountsPanel(name) {
  const add = el("button", { class: "cell-button", type: "button", text: t("providers.addChatgptAccount") });
  add.disabled = chatgptLoginBusy;
  const waiting = el("p", { class: "group-footer", text: chatgptLoginBusy ? t("providers.chatgptAddWaiting") : "" });
  waiting.hidden = !chatgptLoginBusy;
  add.addEventListener("click", () => void startChatgptLogin(() => { renderProviderDetail(); void refreshChatgptAccountPanel(name); }, true));
  const rows = el("div", { id: "chatgpt-account-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.chatgptAccountsTitle") }), el("span", { id: "chatgpt-account-count", class: "small", text: t("providers.chatgptAccountCount", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      waiting,
      el("p", { class: "group-footer", text: t("providers.chatgptAccountsSubtitle") }),
    ]),
  ]);
  queueMicrotask(() => void refreshChatgptAccountPanel(name));
  return panel;
}

/**
 * Whether this provider is one whose keys form a pool: every API-key provider (OpenAI-compatible and
 * Anthropic-compatible, subscription or prepaid credit alike). ChatGPT, Google and Grok sign in
 * instead of taking a key, and the Claude subscription keeps its own account list, so neither is
 * here. The router's `/api/provider-keys` answers for exactly these.
 */
const KEY_BASED_TYPES = new Set(["openai-compatible", "anthropic-compatible"]);
function isKeyBasedProvider(provider) {
  return Boolean(provider) && KEY_BASED_TYPES.has(provider.type);
}

/**
 * The id the router gives the one key a provider keeps in `headers` (proxy `credentialsOf`). The
 * dashboard shows that key as key 1, but the live-state endpoints (`/api/provider-keys`,
 * `/api/limits`) call it `default`, so the card has to look it up under that id or it shows no
 * state and no usage at all.
 */
const HEADERS_KEY_ID = "default";

/** A header that carries a key, in whatever case a config or a form spelled it. */
const AUTH_HEADER = /^(authorization|x-api-key)$/i;

/** The name a headers object actually stores its auth header under ("Authorization", "x-api-key"), or "". */
function authHeaderName(headers) {
  return Object.keys(headers || {}).find((header) => AUTH_HEADER.test(header) && typeof headers[header] === "string" && headers[header].trim()) || "";
}

/** A header's value whatever case it was saved in; a config can hold "Authorization" where a form asks for "authorization". */
function headerValueOf(headers, name) {
  const found = Object.keys(headers || {}).find((header) => header.toLowerCase() === name);
  return found ? headers[found] : undefined;
}

/**
 * The auth header a probe should send for a provider whose key lives in `credentials[]`: the first
 * stored key that is not paused and carries one. A provider migrated to the key pool has no auth
 * header left in `headers`, so a probe built from `headers` alone tested an unauthenticated request
 * and called a working provider broken (opencode-go, 2026-10-21). Only the header is returned and it
 * goes straight into the probe body: no value is ever drawn on the page.
 */
function credentialAuthHeader(provider) {
  const stored = Array.isArray(provider && provider.credentials) ? provider.credentials : [];
  for (const entry of stored) {
    if (!entry || entry.paused || !entry.headers) continue;
    const name = authHeaderName(entry.headers);
    if (name) return { name, value: entry.headers[name] };
  }
  return null;
}

/**
 * A provider's keys as the pool reads them. `credentials` is the saved shape; a provider that has
 * only the old `headers.authorization` shows that one as key 1 and is migrated to `credentials` on
 * the first save here. Only ids, labels and header *names* leave this function — never a value.
 */
function keyRowsOf(provider) {
  const stored = Array.isArray(provider && provider.credentials) ? provider.credentials : [];
  if (stored.length) {
    return stored
      .filter((entry) => entry && typeof entry.id === "string" && entry.id)
      .map((entry, index) => ({ id: entry.id, label: entry.label || t("keys.defaultLabel", { number: index + 1 }), legacy: false }));
  }
  const headers = (provider && provider.headers) || {};
  const hasKey = Object.entries(headers).some(([name, value]) => /^(authorization|x-api-key)$/i.test(name) && typeof value === "string" && value.trim());
  // `legacy` still means "there is no credential to PATCH": the acts go through the config save.
  return hasKey ? [{ id: HEADERS_KEY_ID, label: t("keys.legacyLabel"), legacy: true }] : [];
}

/** The bearer value a key field was given: whatever was pasted, with stray spaces or a prefix taken off. */
function keyValueOf(text) {
  return String(text || "").trim().replace(/^bearer\s+/i, "").replace(/\s+/g, "");
}

/** A pasted key's characters that cannot travel in a header: what the add-key dialog warns about. */
function keyHasSpaces(text) {
  return /\s/.test(String(text || "").trim().replace(/^bearer\s+/i, ""));
}

/** The router's key-character refusal in the words this screen already has for it. */
function keyErrorMessage(error) {
  const raw = String((error && error.message) || "");
  if (/HTTP header|whitespace/i.test(raw)) return t("keys.spaces");
  return raw;
}

/**
 * Save a new list of keys onto the provider, without ever handling a stored key's value.
 *
 * The headers of the keys that already exist are taken from the config the router just sent, matched
 * by id, so a rename or a reorder cannot blank them. Only a newly typed key carries a value. Every
 * other field a key carries (`paused`, and whatever the router adds later) rides along untouched.
 * The whole save starts from `latestConfig()` like every other screen, so a concurrent edit survives.
 */
async function saveProviderKeys(name, change) {
  const next = clone(await latestConfig());
  const saved = next.providers && next.providers[name];
  if (!saved) throw new Error(t("providers.noSelection"));
  const stored = Array.isArray(saved.credentials) ? saved.credentials.filter((entry) => entry && typeof entry.id === "string") : [];
  if (!stored.length) {
    // The provider still holds one key in `headers`; it becomes the credential the router already
    // calls "default" on its first save here, so the pool's health for that key survives the move.
    // The auth header is matched in any case: a hand-edited config can spell it "Authorization".
    const headers = saved.headers || {};
    const card = authHeaderName(headers);
    if (card) {
      stored.push({ id: HEADERS_KEY_ID, label: t("keys.legacyLabel"), headers: { ...headers } });
      const kept = Object.fromEntries(Object.entries(headers).filter(([header]) => !AUTH_HEADER.test(header)));
      if (Object.keys(kept).length) saved.headers = kept;
      else delete saved.headers;
    }
  }
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  // A credential is a complete header set (the router sends it instead of the provider's headers),
  // so a new key takes the provider's other headers with it.
  const sharedHeaders = Object.fromEntries(Object.entries(saved.headers || {}).filter(([header]) => !AUTH_HEADER.test(header)));
  const credentials = change(byId, stored, sharedHeaders).map((entry) => ({
    ...entry,
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    headers: entry.headers,
  }));
  if (credentials.length) saved.credentials = credentials;
  else delete saved.credentials;
  await configRequest(next);
  currentConfig = next;
  providersLoaded = false;
  renderProviderDetail();
}

/**
 * Add a key to a provider: a label and the key itself, in the sheet every other add uses.
 *
 * The key is saved through `POST /api/provider-keys` and joins the pool at once — the router has no
 * separate "enable" step, and the form says so. Afterwards the provider's 계정 tab is shown with the
 * new card, because that is where its state and place in the order live.
 */
function openAddKeyDialog(name, options) {
  const labelInput = el("input", { type: "text", maxlength: "60", autocomplete: "off", placeholder: t("keys.labelPlaceholder") });
  const keyInput = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: t("keys.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => {
    const show = keyInput.type === "password";
    keyInput.type = show ? "text" : "password";
    showKey.textContent = show ? t("common.hide") : t("common.show");
  });
  const problem = el("small", { class: "bad-text", role: "alert", hidden: "" });
  const save = el("button", { class: "btn", type: "button", "data-default-action": "", text: t("keys.add") });
  const check = () => {
    const key = keyValueOf(keyInput.value);
    const issue = key && keyHasSpaces(keyInput.value) ? t("keys.spaces") : "";
    problem.textContent = issue;
    problem.hidden = !issue;
    save.disabled = !key || Boolean(issue);
  };
  keyInput.addEventListener("input", check);
  check();
  save.addEventListener("click", async () => {
    const key = keyValueOf(keyInput.value);
    if (!key) return;
    save.disabled = true;
    const label = labelInput.value.trim();
    try {
      await api(`/api/provider-keys?provider=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The router refuses an empty label, and a blank name is a normal thing to leave alone:
        // the field is not sent at all, so the key is saved with the default name instead.
        body: JSON.stringify({ key, ...(label ? { label } : {}) }),
      });
      closeModal();
      await afterKeyAdded(name, options);
    } catch (error) {
      save.disabled = false;
      toast(t("common.saveFailed"), true, keyErrorMessage(error));
    }
  });
  showModal(el("div", {}, [
    el("h1", { id: "modal-title", text: t("keys.addTitle") }),
    hint(t("keys.addHelp")),
    el("label", { class: "form-field" }, [el("span", { text: t("keys.label") }), labelInput, el("small", { text: t("keys.labelOptional") })]),
    el("div", { class: "form-field key-field" }, [
      el("span", { text: t("keys.key") }),
      el("div", { class: "key-control" }, [keyInput, showKey]),
      problem,
      el("small", { text: t("keys.keyHelp") }),
    ]),
    el("p", { class: "small", text: t("keys.addRotationNote") }),
    el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), save]),
  ]));
}

/**
 * After a key is saved: re-read the config, open the provider's 계정 tab and draw its cards. The
 * add-provider path hands back the name it merged into, so the page follows to that provider.
 */
async function afterKeyAdded(name, options) {
  try { currentConfig = await api("/api/config"); } catch { /* the panel reports an unreachable router */ }
  // Without a config there is no rail to draw; the toast still says the key was saved.
  if (!currentConfig) { toast((options && options.notice) || t("keys.added")); return; }
  selectedProviderName = name;
  providerDetailTab = "accounts";
  if (!$("#view-providers").classList.contains("active")) showView("providers");
  $("#view-providers").classList.add("show-detail");
  renderProviderWorkspace();
  const notice = options && options.notice;
  toast(notice || t("keys.added"));
}

/**
 * Rename one key. The label is the only editable thing: the router never hands a saved key back.
 * `apply` lets a caller save through its own endpoint (`PATCH /api/provider-keys/:id`); without one
 * the label goes through the config save, which is what a provider form's keys use.
 */
function openRenameKeyDialog(name, row, apply) {
  const input = el("input", { type: "text", value: row.label, maxlength: "60", autocomplete: "off" });
  const save = el("button", { class: "btn", type: "button", "data-default-action": "", text: t("common.save") });
  const check = () => { save.disabled = !input.value.trim() || input.value.trim() === row.label; };
  input.addEventListener("input", check);
  check();
  save.addEventListener("click", async () => {
    const label = input.value.trim();
    if (!label) return;
    save.disabled = true;
    try {
      if (apply) await apply(label);
      else await saveProviderKeys(name, (byId, stored) => stored.map((entry) => entry.id === row.id ? { ...entry, label } : entry));
      closeModal();
      toast(t("common.saved"));
    } catch (error) {
      save.disabled = false;
      toast(t("common.saveFailed"), true, error.message);
    }
  });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !save.disabled) save.click(); });
  showModal(el("div", {}, [
    el("h1", { id: "modal-title", text: t("keys.renameTitle") }),
    el("label", { class: "form-field" }, [el("span", { text: t("keys.label") }), input, el("small", { text: t("keys.renameHelp") })]),
    el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), save]),
  ]));
  setTimeout(() => input.focus(), 0);
}

function removeProviderKey(name, row, rows) {
  if (!confirm(t("keys.removeConfirm", { name: row.label }))) return;
  void saveProviderKeys(name, (byId, stored) => stored.filter((entry) => entry.id !== row.id))
    .then(() => toast(t("keys.removed")))
    .catch((error) => toast(t("common.saveFailed"), true, error.message));
}

/** Move a key one place up or down; the router tries the list in this order. */
function moveProviderKey(name, row, rows, delta) {
  const at = rows.findIndex((entry) => entry.id === row.id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= rows.length) return;
  void saveProviderKeys(name, (byId, stored) => {
    const ordered = [...stored];
    const [moved] = ordered.splice(at, 1);
    ordered.splice(to, 0, moved);
    return ordered;
  }).catch((error) => toast(t("common.saveFailed"), true, error.message));
}

/**
 * A key-based provider's keys. The same card list as the ChatGPT accounts tab: one card per key, in
 * the order the router tries them, with the key's state, its usage (or its balance for a prepaid
 * credit vendor) and the same actions. A conversation keeps its own key while that key is healthy,
 * so the order only matters when one is cooling.
 *
 * Every act on a saved key goes to `/api/provider-keys` so the router writes the key's own field and
 * no other card's header is touched. A key that lives only in the provider's old `headers` shape is
 * migrated by the router when it is added or paused through the same endpoint; the config save
 * (`PUT /api/config`) still carries the order.
 *
 * A stored key is shown as "저장한 키를 쓰고 있습니다" and nothing more — the router keeps the value,
 * and this screen never puts it back on the page.
 */
const KEY_STATES = new Set(["in-use", "standby", "cooling", "paused", "quarantined", "unknown"]);

/** "5시간 33% · 주간 86% · 월간 55%" — the same line the ChatGPT cards use for a quota. */
function keyQuotaText(windows) {
  const list = Array.isArray(windows) ? windows : [];
  return list.filter((window) => window && typeof window.used_percent === "number").map((window) =>
    t("quota.line", { window: usageWindowLongName(window), percent: Math.round(window.used_percent) }).trim(),
  ).join(" · ");
}

/** A key's prepaid balance as the card writes it: "잔액 $738", and the days left when known. */
function keyCreditText(credit) {
  if (!credit || typeof credit.remaining_usd !== "number") return "";
  const days = typeof credit.days_remaining === "number" && Number.isFinite(credit.days_remaining) ? ` · ${usageCreditDays(credit.days_remaining)}` : "";
  return `${t("usage.creditBalance")} ${usageUsd(credit.remaining_usd)}${days}`;
}

function keyStateBadge(account) {
  const state = KEY_STATES.has(account.state) ? account.state : null;
  const cooldown = typeof account.cooldown_seconds === "number" ? account.cooldown_seconds : 0;
  if (state === "paused") return el("span", { class: "badge", text: t("providers.chatgptPaused") });
  if (state === "quarantined") return el("span", { class: "badge bad", text: t("keys.stateQuarantined") });
  if (state === "cooling") return el("span", { class: "badge warn", text: t("keys.stateCooling", { duration: durationText(cooldown) }) });
  if (state === "in-use") return el("span", { class: "badge ok", text: t("providers.chatgptInUse") });
  // The router says "unknown" for a key nothing has read yet. That is not standby: it has no
  // reading at all, and saying "대기" would promise a slot the router never confirmed.
  if (state === "unknown") return el("span", { class: "badge", text: t("keys.stateUnknown") });
  return el("span", { class: "badge", text: t("providers.chatgptStandby") });
}

/** The provider's key endpoint; `id` names one saved key. */
function keyUrl(name, id) {
  const base = `/api/provider-keys${id ? `/${encodeURIComponent(id)}` : ""}?provider=${encodeURIComponent(name)}`;
  return base;
}

/** The one PATCH shape the endpoint takes: a label, a pause flag, or a cooldown cleared now. */
async function patchProviderKey(name, id, change) {
  await api(keyUrl(name, id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
}

/**
 * The key stored only in the provider's `headers` has no credential id for the endpoint to address.
 * Editing it goes through the config save, which turns it into key 1 as it writes; `apply` edits
 * that one saved entry.
 */
function editLegacyKey(name, apply) {
  return saveProviderKeys(name, (byId, stored) => stored.map((entry, index) => (index === 0 ? apply(entry) : entry)));
}

async function setProviderKeyPaused(name, row, paused) {
  try {
    if (row.legacy) await editLegacyKey(name, (entry) => ({ ...entry, paused: paused || undefined }));
    else await patchProviderKey(name, row.id, { paused });
    await reloadProviderKeys(name);
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

/**
 * "대기 해제": the key is usable again now instead of at its window's reset.
 *
 * A key that lives only in the provider's old `headers` shape still exists in the pool as id
 * "default" (`HEADERS_KEY_ID`), and clearing a cooldown touches the pool's memory, not the config
 * file — so the router's PATCH accepts it for that id even though there is no credential entry to
 * carry a label or a pause (`admin.ts` `providerKeyKnown`). The legacy card therefore takes the
 * same PATCH as every other key; re-saving the config instead (the old behaviour) left the key
 * cooling, because that save never reaches the pool.
 *
 * The config save stays as the fallback for a router whose PATCH refuses the headers id (404/400):
 * that save migrates the key to `credentials`, and the pool has no health recorded for the new id,
 * so the key is picked again at once.
 */
async function clearProviderKeyCooldown(name, row) {
  try {
    try {
      await patchProviderKey(name, row.legacy ? HEADERS_KEY_ID : row.id, { clearCooldown: true });
    } catch (error) {
      if (!row.legacy || (error.status !== 404 && error.status !== 400)) throw error;
      await editLegacyKey(name, (entry) => entry);
    }
    await reloadProviderKeys(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}

async function renameProviderKey(name, row, label) {
  try {
    if (row.legacy) await editLegacyKey(name, (entry) => ({ ...entry, label }));
    else await patchProviderKey(name, row.id, { label });
    await reloadProviderKeys(name);
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

async function removeProviderKeyById(name, row) {
  if (!confirm(t("keys.removeConfirm", { name: row.label }))) return;
  try {
    if (row.legacy) await saveProviderKeys(name, (byId, stored) => []);
    else await api(keyUrl(name, row.id), { method: "DELETE" });
    toast(t("keys.removed"));
    await reloadProviderKeys(name);
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

/** The config changed under us (a key added, paused, renamed or removed): re-read it, then draw. */
async function reloadProviderKeys(name) {
  try { currentConfig = await api("/api/config"); } catch { /* keep the copy on screen */ }
  if (selectedProviderName === name && providerDetailTab === "accounts") renderProviderDetail();
}

/**
 * Draw the key cards. `data` is `GET /api/provider-keys` — `{ accounts: [{ id, label?, state,
 * cooldown_seconds?, at, windows, credit? }] }` — or null when this router does not have that
 * endpoint yet (an older build), in which case the cards still list and edit the keys from the config.
 */
function renderProviderKeyRows(target, data, name) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[name];
  if (!provider) return;
  const rows = keyRowsOf(provider);
  const live = new Map(((data && Array.isArray(data.accounts)) ? data.accounts : []).filter((account) => account && typeof account.id === "string").map((account) => [account.id, account]));
  const cards = rows.map((row, index) => {
    const account = live.get(row.id);
    const known = Boolean(account);
    // The state endpoint names "paused" itself; before it exists, the saved flag in the config does.
    const paused = known ? account.state === "paused" : byIdPaused(name, row.id);
    const cooling = known && account.state === "cooling";
    const inUse = known && account.state === "in-use";
    const actions = [];
    if (cooling) {
      const clear = el("button", { class: "btn secondary compact", type: "button", text: t("providers.chatgptClearCooldown") });
      clear.addEventListener("click", () => void clearProviderKeyCooldown(name, row));
      actions.push(clear);
    }
    const pause = el("button", { class: "btn secondary compact", type: "button", text: paused ? t("providers.chatgptResume") : t("providers.chatgptPause") });
    pause.addEventListener("click", () => void setProviderKeyPaused(name, row, !paused));
    const up = el("button", { class: "icon-btn", type: "button", "aria-label": t("keys.moveUp"), title: t("keys.moveUp") }, [svgIcon("0 0 10 6", ["M1 5l4-4 4 4"])]);
    up.disabled = index === 0;
    up.addEventListener("click", () => moveProviderKey(name, row, rows, -1));
    const down = el("button", { class: "icon-btn", type: "button", "aria-label": t("keys.moveDown"), title: t("keys.moveDown") }, [svgIcon("0 0 10 6", ["M1 1l4 4 4-4"])]);
    down.disabled = index === rows.length - 1;
    down.addEventListener("click", () => moveProviderKey(name, row, rows, 1));
    const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
    rename.addEventListener("click", () => openRenameKeyDialog(name, row, (label) => renameProviderKey(name, row, label)));
    const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
    remove.addEventListener("click", () => void removeProviderKeyById(name, row));
    actions.push(pause, up, down, rename, remove);
    const quota = known ? keyQuotaText(account.windows) : "";
    const credit = known ? keyCreditText(account.credit) : "";
    return el("article", { class: `cell account-card${inUse ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: (account && account.label) || row.label }),
        el("span", { class: "small mono key-saved", text: t("providers.keySaved") }),
        row.legacy ? hint(t("keys.legacyHelp")) : null,
        quota ? el("p", { class: "small account-quota", text: quota }) : null,
        credit ? el("p", { class: `small account-quota${account.credit.low ? " bad-text" : ""}`, text: credit }) : null,
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, [
        known ? keyStateBadge(account) : null,
      ].filter(Boolean)),
    ]);
  });
  target.replaceChildren(...(cards.length ? cards : [el("div", { class: "account-empty", text: t("keys.empty") })]));
  const countNode = $("#provider-key-count");
  if (countNode) countNode.textContent = t("keys.count", { count: rows.length });
}

/** A key's saved `paused` flag, straight from the config the page already holds (no header value read). */
function byIdPaused(name, id) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[name];
  const entry = ((provider && provider.credentials) || []).find((item) => item && item.id === id);
  return Boolean(entry && entry.paused);
}

async function refreshProviderKeyPanel(name) {
  const target = $("#provider-key-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  let data = null;
  try { data = await api(keyUrl(name)); }
  catch { /* an older router has no state endpoint yet: the cards still list and edit the keys */ }
  if (generation !== providerDetailGeneration) return;
  renderProviderKeyRows(target, data, name);
}

function providerKeysPanel(name) {
  const add = el("button", { class: "cell-button", type: "button", text: t("keys.addAction") });
  add.addEventListener("click", () => openAddKeyDialog(name));
  const rows = el("div", { id: "provider-key-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("keys.title") }), el("span", { id: "provider-key-count", class: "small", text: t("keys.count", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      el("p", { class: "group-footer", text: t("keys.subtitle") }),
    ]),
  ]);
  queueMicrotask(() => void refreshProviderKeyPanel(name));
  return panel;
}

function renderProviderDetail() {
  const detail = $("#provider-detail");
  providerDetailGeneration += 1;
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[selectedProviderName];
  if (!provider) {
    detail.replaceChildren(el("div", { class: "provider-detail-empty" }, [el("strong", { text: t("providers.noSelection") })]));
    return;
  }
  const name = selectedProviderName;
  const check = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  check.addEventListener("click", async () => { check.disabled = true; await probeProvider(name, provider); check.disabled = false; renderProviderWorkspace(); });
  const edit = el("button", { class: "btn secondary", type: "button", text: t("common.edit"), onclick: () => openProviderForm({ name, provider }) });
  // A provider that takes API keys offers the key first: it is the thing people come here to do.
  const addKey = isKeyBasedProvider(provider) ? el("button", { class: "btn", type: "button", text: t("providers.addApiKey") }) : null;
  if (addKey) addKey.addEventListener("click", () => openAddKeyDialog(name));
  // Removing is the one destructive act on this page, so it sits apart at the bottom, not beside Edit.
  const remove = el("button", { class: "cell-button destructive", type: "button", text: t("providers.remove"), onclick: () => void removeProvider(name, provider) });
  const back = el("button", { class: "provider-back", type: "button", onclick: closeProviderDetail }, [svgIcon("0 0 9 15", ["M7.5 1.5l-6 6 6 6"]), el("span", { text: t("nav.providers") })]);
  const header = el("header", { class: "provider-detail-header" }, [
    el("div", {}, [el("div", { class: "provider-title-line" }, [el("h2", { text: name }), providerState(name, provider)]), el("p", { class: "small", text: providerKind(name, provider) })]),
    el("div", { class: "provider-detail-actions" }, [addKey, check, edit].filter(Boolean)),
  ]);
  let content;
  if (providerDetailTab === "accounts" && provider.type === "anthropic" && provider.auth === "claude-code") content = anthropicAccountsPanel(name, provider);
  else if (providerDetailTab === "accounts" && provider.type === "chatgpt") content = chatgptAccountsPanel(name);
  else if (providerDetailTab === "accounts" && provider.type === "google" && provider.auth === "antigravity") content = googleAccountsPanel(name);
  else if (providerDetailTab === "accounts" && isKeyBasedProvider(provider)) content = providerKeysPanel(name);
  else if (providerDetailTab === "models") content = providerModelsPanel(name, provider);
  else { providerDetailTab = "overview"; content = providerOverview(name, provider); }
  detail.replaceChildren(back, header, providerTabs(name, provider), content, el("div", { class: "group provider-remove" }, [remove]));
}

function renderProviderWorkspace() {
  const entries = Object.entries((currentConfig && currentConfig.providers) || {});
  if (!selectedProviderName || !currentConfig.providers[selectedProviderName]) selectedProviderName = entries[0] ? entries[0][0] : null;
  renderProviderRail();
  renderProviderDetail();
}

async function loadClients() {
  clientsLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    if (!status) status = await api("/api/status");
    renderClients();
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}

async function loadProviders() {
  providersLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    renderProviderWorkspace();
    void Promise.all(Object.entries(currentConfig.providers || {}).map(([name, provider]) => probeProvider(name, provider, () => {
      if ($("#view-providers").classList.contains("active")) renderProviderWorkspace();
    })));
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}
$("#providers-search").addEventListener("input", (event) => { providerSearch = event.target.value; renderProviderRail(); });
$("#providers-add").addEventListener("click", openProviderChooser);
$("#providers-refresh").addEventListener("click", async () => {
  if (!currentConfig) return;
  const button = $("#providers-refresh");
  button.disabled = true;
  await Promise.all(Object.entries(currentConfig.providers).map(([name, provider]) => probeProvider(name, provider)));
  button.disabled = false;
  renderProviderWorkspace();
});

// ---- Provider modal -----------------------------------------------------------------

let modalCleanup = null;
function showModal(content, cleanup) {
  if (modalCleanup) modalCleanup();
  modalCleanup = cleanup || null;
  $("#modal-content").replaceChildren(content);
  $("#modal-backdrop").hidden = false;
  const first = $("#modal-content input, #modal-content button, #modal-content select");
  if (first) setTimeout(() => first.focus(), 0);
}
function closeModal() {
  const cleanup = modalCleanup;
  modalCleanup = null;
  if (cleanup) cleanup();
  $("#modal-backdrop").hidden = true;
  $("#modal-content").replaceChildren();
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal-backdrop").addEventListener("click", (event) => { if (event.target === $("#modal-backdrop")) closeModal(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#modal-backdrop").hidden) { closeModal(); return; }
  if (event.key === "Enter" && !$("#modal-backdrop").hidden && event.target.tagName !== "TEXTAREA") {
    const action = $("#modal-content [data-default-action]");
    if (action && !action.disabled) { event.preventDefault(); action.click(); }
  }
});

function openClaudeAccountConsent(providerName) {
  const accepted = el("input", { type: "checkbox" });
  const proceed = el("button", { class: "btn", type: "button", "data-default-action": "", text: t("providers.anthropicOAuthContinue") });
  proceed.disabled = true;
  accepted.addEventListener("change", () => { proceed.disabled = !accepted.checked; });
  proceed.addEventListener("click", () => void openClaudeAccountSignIn(providerName, false));
  showModal(el("div", { class: "oauth-consent" }, [
    el("h1", { id: "modal-title", text: t("providers.anthropicOAuthTitle") }),
    el("div", { class: "notice warn" }, [el("strong", { text: t("providers.anthropicOAuthTitle") }), el("span", { text: t("providers.anthropicOAuthWarning") })]),
    el("label", { class: "check oauth-accept" }, [accepted, el("span", { text: t("providers.anthropicOAuthAccept") })]),
    el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), proceed]),
  ]));
}

async function openClaudeAccountSignIn(providerName, manual) {
  let active = true;
  let poll = null;
  const body = el("div", { class: "oauth-progress" });
  function stopPolling() { if (poll) clearInterval(poll); poll = null; }
  function showError(state) {
    stopPolling();
    if (!active) return;
    const retry = el("button", { class: "btn secondary", type: "button", text: t("providers.anthropicSignInManual") });
    retry.addEventListener("click", () => void openClaudeAccountSignIn(providerName, true));
    body.replaceChildren(el("span", { class: "bad-text", text: t("providers.anthropicSignInFailed") }), state.error ? el("p", { class: "small", text: state.error }) : null, retry);
  }
  async function finish(state) {
    stopPolling();
    if (!active) return;
    if (!state.ok) { showError(state); return; }
    active = false;
    closeModal();
    if (selectedProviderName === providerName) {
      providerDetailTab = "accounts";
      renderProviderDetail();
    }
    toast(t("providers.anthropicLoginDone"));
  }
  function renderState(state) {
    const controls = [
      el("p", { text: state.manual ? t("providers.anthropicSignInPaste") : t("providers.anthropicSignInBrowser") }),
      state.url ? el("a", { class: "login-link", href: state.url, target: "_blank", rel: "noreferrer", text: t("providers.anthropicSignInLink") }) : null,
    ];
    if (state.manual) {
      const code = el("input", { type: "text", autocomplete: "off", placeholder: "code#state" });
      const submit = el("button", { class: "btn", type: "button", text: t("providers.anthropicSignInSubmit") });
      submit.addEventListener("click", async () => {
        submit.disabled = true;
        try { await finish(await api("/api/claude-oauth/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.value }) })); }
        catch (error) { showError((error.body && { ok: false, error: error.body.error }) || { ok: false, error: error.message }); }
      });
      controls.push(el("div", { class: "key-control" }, [code, submit]));
    } else controls.push(el("p", { class: "small", text: t("providers.anthropicSignInWaiting") }));
    controls.push(el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }));
    body.replaceChildren(...controls.filter(Boolean));
  }
  showModal(el("div", {}, [el("h1", { id: "modal-title", text: t("providers.anthropicOAuthTitle") }), body]), () => {
    const wasActive = active;
    active = false;
    stopPolling();
    if (wasActive) void api("/api/claude-oauth/cancel", { method: "POST" }).catch(() => {});
  });
  body.replaceChildren(el("p", { class: "small", text: t("providers.checking") }));
  try {
    const state = await api("/api/claude-oauth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manual: Boolean(manual) }) });
    if (!active) return;
    renderState(state);
    poll = setInterval(async () => {
      try {
        const next = await api("/api/claude-oauth");
        if (!next.running) await finish(next);
      } catch { /* keep the last useful state while the router is busy */ }
    }, 2000);
  } catch (error) { showError({ ok: false, error: error.message }); }
}

// The services one can connect, as grouped lists: sign-in subscriptions first, then the API-key
// presets by the format they speak (the "paste a key" note is said once per group, not per row),
// then the manual entry on its own.
function openProviderChooser() {
  const grid = el("div", { class: "chooser-grid" });
  function tile(title, help, options) {
    const button = el("button", { class: "chooser-tile", type: "button" }, [el("span", { class: "cell-text" }, [el("strong", { text: title }), help ? el("span", { text: help }) : null]), chevronIcon()]);
    button.addEventListener("click", () => openProviderForm(options));
    return button;
  }
  function group(title, tiles, footer, single) {
    if (!tiles.length) return;
    grid.appendChild(el("section", { class: "chooser-section" }, [
      title ? el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: title })]) : null,
      el("div", { class: `group chooser-group chooser-tiles${single ? " single" : ""}` }, tiles),
      footer ? el("p", { class: "group-footer", text: footer }) : null,
    ]));
  }
  group(t("providers.subscriptionGroup"), [
    tile(t("providers.anthropic"), t("providers.anthropicHelp"), { kind: "anthropic" }),
    tile(t("providers.chatgpt"), t("providers.chatgptHelp"), { kind: "chatgpt" }),
    tile(t("providers.google"), t("providers.googleHelp"), { kind: "google" }),
    tile(t("providers.grok"), t("providers.grokHelp"), { kind: "grok" }),
  ], null, true);
  const native = presets.filter((preset) => (preset.kind || "anthropic-compatible") === "anthropic-compatible");
  group(t("providers.anthropicGroup"), native.map((preset) => tile(preset.name, null, { preset })), t("providers.presetHelp"));
  const openai = presets.filter((preset) => preset.kind === "openai-compatible");
  group(t("providers.openaiGroup"), openai.map((preset) => tile(preset.name, null, { preset })), `${t("providers.presetHelp")} ${t("providers.openaiGroupHelp")}`);
  group(null, [tile(t("providers.custom"), t("providers.customHelp"), { kind: "custom" })], null, true);
  showModal(el("div", {}, [el("h1", { id: "modal-title", text: t("providers.choose") }), hint(t("providers.chooseHelp")), grid]));
}
function inputRow(label, control, helpText) {
  return el("label", { class: "form-field" }, [el("span", { text: label }), control, helpText ? el("small", { text: helpText }) : null]);
}
// Checklist that stays usable with hundreds of models (OpenRouter lists 400+): a search box, checked
// entries pinned first, at most 36 visible rows, and the selection kept in a Set so filtering never
// loses ticks. `box.selected()` returns the chosen entries, each carrying whatever per-model override
// it arrived with (effortLevels, contextWindow, and the wire/url/authHeader a preset gave it) so a
// save does not strip the endpoint the model speaks.
function modelOverrideFields(model) {
  return {
    ...(Array.isArray(model.effortLevels) ? { effortLevels: [...model.effortLevels] } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(model.wire ? { wire: model.wire } : {}),
    ...(model.url ? { url: model.url } : {}),
    ...(model.authHeader ? { authHeader: model.authHeader } : {}),
  };
}
// A provider form holds the per-model fields from when it opened, and has no control for them; a
// measurement may have landed since. So a model the router already has keeps the router's values.
function withSavedModelFields(models, saved) {
  const known = new Map(modelsOf(saved).map((model) => [model.id, model]));
  return models.map((model) => known.has(model.id) ? { ...model, ...modelOverrideFields(known.get(model.id)) } : model);
}
function modelChecklist(models, checked, options = {}) {
  models = [...models];
  const selected = new Map();
  for (const model of models) if (checked.has(model.id)) selected.set(model.id, { id: model.id, name: labelOf(model), ...modelOverrideFields(model) });
  const wrap = el("div", { class: "model-picker" });
  const grid = el("div", { class: "model-checklist modal-checklist" });
  const note = el("div", { class: "small", text: "" });
  const search = models.length > 12 ? el("input", { type: "search", placeholder: t("providers.searchModels"), class: "model-search" }) : null;
  const LIMIT = 36;
  function render() {
    const q = (search ? search.value : "").trim().toLowerCase();
    const matches = models.filter((m) => !q || m.id.toLowerCase().includes(q) || labelOf(m).toLowerCase().includes(q));
    const pinned = matches.filter((m) => selected.has(m.id));
    const rest = matches.filter((m) => !selected.has(m.id)).slice(0, Math.max(0, LIMIT - pinned.length));
    grid.replaceChildren();
    for (const model of [...pinned, ...rest]) {
      const input = el("input", { type: "checkbox", checked: selected.has(model.id) });
      input.dataset.model = model.id;
      input.dataset.name = labelOf(model);
      input.addEventListener("change", () => {
        if (input.checked) selected.set(model.id, { id: model.id, name: labelOf(model), ...modelOverrideFields(model) });
        else selected.delete(model.id);
        note.textContent = summary(matches.length);
      });
      const tag = modelEffortTag(model);
      grid.appendChild(el("label", { class: "model-check", title: model.id }, [input, el("span", { text: labelOf(model) }), tag ? el("span", { class: `model-effort-tag ${model.effortLevels.length ? "has-effort" : "no-effort"}`, text: tag }) : null]));
    }
    note.textContent = summary(matches.length);
  }
  function summary(matchCount) {
    const hidden = Math.max(0, matchCount - Math.min(matchCount, LIMIT));
    return t("providers.modelsSummary", { selected: selected.size, total: models.length }) + (hidden > 0 ? " · " + t("providers.modelsHidden", { hidden }) : "");
  }
  if (search) { search.addEventListener("input", render); wrap.appendChild(search); }
  wrap.append(grid, note);
  // A provider without a model list (or one that leaves a model off it) is otherwise unusable: the
  // only ids on offer are the ones fetched, and abliteration.ai lists none (issue #42).
  if (options.allowCustom) {
    const idInput = el("input", { placeholder: t("providers.customModelPlaceholder"), autocomplete: "off", spellcheck: "false" });
    const addButton = el("button", { class: "btn secondary", type: "button", text: t("providers.customModelAdd") });
    function addTyped() {
      const id = idInput.value.trim();
      if (!id) return;
      if (!models.some((model) => model.id === id)) models.unshift({ id, name: id });
      const model = models.find((entry) => entry.id === id);
      selected.set(id, { id, name: labelOf(model), ...modelOverrideFields(model) });
      idInput.value = "";
      if (search) search.value = "";
      render();
    }
    addButton.addEventListener("click", addTyped);
    // Enter here adds the id; left to bubble, the modal's own Enter handler would save the form too.
    idInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); addTyped(); } });
    wrap.appendChild(el("div", { class: "key-control model-add" }, [idInput, addButton]));
  }
  wrap.selected = () => [...selected.values()];
  render();
  return wrap;
}
function anthropicSourceText(source) {
  if (source === "observed") return t("providers.anthropicSourceObserved");
  if (source === "keychain" || source === "credentials-file" || source === "env") return t("providers.anthropicSourceClaudeCode");
  if (source === "token-file") return t("providers.anthropicSourceTokenFile");
  return t("providers.anthropicSourceMissing");
}
function openAnthropicProviderForm(options) {
  let formActive = true;
  const existing = options.provider;
  const displayName = options.name || t("providers.anthropic");
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const auth = el("select", {}, [selectOption("claude-code", t("providers.anthropicAuthClaudeCode")), selectOption("api-key", t("providers.anthropicAuthApiKey"))]);
  auth.value = (existing && existing.auth) || "claude-code";
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: existing && existing.apiKey ? t("providers.keySaved") : t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const sourceLine = el("div", { class: "small" });
  let foundModels = modelsOf(existing).length ? modelsOf(existing) : claudeModels.map((model) => ({ id: model.id, name: labelOf(model) }));
  let selected = new Set(existing ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
  const modelArea = el("div", { class: "form-field" });
  function renderModels() {
    const modelsBox = modelChecklist(foundModels, selected);
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(t("providers.modelsHelp")), el("small", { text: t("providers.effortLevels", { levels: "low · medium · high · max" }) }), modelsBox);
  }
  renderModels();
  const authField = inputRow(t("providers.credentials"), auth, t("providers.anthropicCredentialsHelp"));
  const keyField = el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.keyHelp") })]);
  const accountPool = existing ? Boolean(existing.accountPool) : true;
  function syncAuthFields() {
    const reused = auth.value === "claude-code";
    keyField.hidden = reused;
    sourceLine.hidden = !reused;
  }
  auth.addEventListener("change", syncAuthFields);
  syncAuthFields();
  async function runProbe() {
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    try {
      const body = auth.value === "claude-code" ? { type: "anthropic", auth: "claude-code" } : { type: "anthropic", auth: "api-key", apiKey: keyInput.value || (existing && existing.apiKey) };
      const response = await api("/api/providers/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!formActive) return;
      sourceLine.textContent = anthropicSourceText(response.source);
      const noCredits = response.ok && /^no-credits:/.test(response.error || "");
      result.replaceChildren(...[
        el("span", { class: response.ok && !noCredits ? "ok-text" : noCredits ? "warn-text" : "bad-text", text: noCredits ? t("providers.probeNoCredits") : response.ok ? t("providers.probeOk") : response.auth === "not-entitled" ? t("providers.probeNotEntitled") : response.auth === "bad-key" ? t("providers.probeBadKey") : auth.value === "claude-code" ? anthropicSourceText(response.source) : t("providers.probeFailed") }),
        response.error ? el("div", { class: "small", text: response.error.replace(/^no-credits:\s*/, "") }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        // Anthropic's own list, so a release shows up here without a ClaudeRipple update. A saved
        // model the list no longer carries stays visible and ticked rather than dropped on save.
        const listed = new Set(response.models.map((model) => model.id));
        foundModels = [...response.models, ...modelsOf(existing).filter((model) => !listed.has(model.id))];
        selected = new Set(existing ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
        renderModels();
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  // The Claude login needs nothing typed, so fetch the account's model list as soon as the form
  // opens: a saved provider otherwise showed only what was ticked when it was first saved.
  if (auth.value === "claude-code") setTimeout(() => void runProbe(), 0);
  const modeHint = hint("");
  function syncModeHint() { modeHint.textContent = auth.value === "claude-code" && accountPool ? t("providers.anthropicPoolRouting") : t("providers.anthropicIngressOnly"); }
  auth.addEventListener("change", syncModeHint);
  syncModeHint();
  const limitsInput = el("input", { type: "checkbox", checked: !(existing && existing.limits === false) });
  const limitsField = el("div", { class: "form-field" }, [el("label", { class: "check" }, [limitsInput, el("span", { text: t("providers.limits") })]), el("small", { text: t("providers.limitsHelp") })]);
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")), authField, keyField, probeButton, sourceLine, result, modelArea,
    modeHint, limitsField,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), existing && next.providers[options.name]);
    const provider = { type: "anthropic", auth: auth.value, ...(auth.value === "claude-code" && accountPool ? { accountPool: true } : {}), ...(auth.value === "api-key" && (keyInput.value || (existing && existing.apiKey)) ? { apiKey: keyInput.value || existing.apiKey } : {}), limits: limitsInput.checked, models: checkedModels };
    next.providers[providerName] = provider;
    // accountPool makes these models native Claude routing targets. Without it this remains the
    // historical OpenAI ingress provider, and routing deliberately ignores it.
    saveButton.disabled = true;
    try { await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = auth.value === "claude-code" ? "accounts" : "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); toast(t("common.saved")); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  if (auth.value === "claude-code") void runProbe();
}
/**
 * What a Grok form's check leaves ticked. A handful of models, so a new provider's first listing
 * starts with all of them ticked. Every later check — and every check of a saved provider — keeps
 * what is ticked at that moment, so a model the user unticked stays unticked.
 */
function grokTickedAfterCheck(firstListing, tickedIds, listedIds) {
  return new Set(firstListing ? listedIds : tickedIds);
}

/**
 * A Grok subscription: nothing to type. The router reads the Grok CLI's own session, so the form
 * checks that it is there, lists what the proxy offers and saves the ticked models. The check runs
 * as soon as the form opens, since there is no key to wait for.
 */
function openGrokProviderForm(options) {
  let formActive = true;
  const existing = options.provider;
  const nameInput = el("input", { value: options.name || t("providers.grok"), maxlength: "60" });
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  let foundModels = modelsOf(existing);
  const currentChecked = new Set(foundModels.map((model) => model.id));
  let listed = false;
  const modelArea = el("div", { class: "form-field" });
  function renderModels(checked, help) {
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(help || t("providers.modelsHelp")), modelChecklist(foundModels, checked, { allowCustom: true }));
  }
  renderModels(currentChecked);
  // Fields this form has no control for (a home, a binary, a pinned version) go to the probe as saved.
  const probeBody = () => ({ type: "grok", ...Object.fromEntries(["home", "cli", "url", "clientVersion"].filter((key) => existing && existing[key]).map((key) => [key, existing[key]])) });
  async function runProbe() {
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    try {
      const response = await api("/api/providers/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(probeBody()) });
      if (!formActive) return;
      const failed = response.auth === "missing" || response.auth === "bad-key" ? t("providers.grokSignInFirst") : t("providers.probeFailed");
      result.replaceChildren(...[
        el("span", { class: response.ok ? "ok-text" : "bad-text", text: response.ok ? t("providers.probeOk") : failed }),
        response.error ? el("div", { class: "small", text: response.error }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        const ticked = modelArea.querySelector(".model-picker").selected();
        const keep = grokTickedAfterCheck(!existing && !listed, ticked.map((model) => model.id), response.models.map((model) => model.id));
        listed = true;
        foundModels = [...ticked.filter((model) => !response.models.some((m) => m.id === model.id)), ...response.models];
        renderModels(keep);
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  const advanced = el("details", { class: "details" }, [el("summary", { text: t("common.advanced") })]);
  const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
  const limitsInput = el("input", { type: "checkbox", checked: !(existing && existing.limits === false) });
  const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
  advanced.appendChild(el("div", { class: "advanced-content" }, [
    el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
    el("div", { class: "form-field" }, [el("label", { class: "check" }, [limitsInput, el("span", { text: t("providers.limits") })]), el("small", { text: t("providers.limitsHelp") })]),
    inputRow(t("providers.append"), append, t("providers.appendHelp")),
  ]));
  const pickerInput = el("input", { type: "checkbox", checked: existing ? modelsOf(existing).some((model) => ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === model.id)) : true });
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")),
    el("div", { class: "form-field" }, [el("span", { text: t("providers.credentials") }), hint(t("providers.grokFormHelp")), el("small", { class: "warn-text", text: t("providers.grokWarningShort") })]),
    probeButton, result, modelArea,
    el("label", { class: "check picker-check" }, [pickerInput, el("span", { text: t("providers.showInPicker") })]),
    pickerModeOn() ? null : hint(t("providers.pickerOffHint")),
    advanced,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const saved = existing && (next.providers[options.name] || existing);
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    const formKeys = new Set(["type", "identity", "limits", "instructionsAppend", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = {
      ...kept,
      type: "grok",
      identity: identity.checked,
      limits: limitsInput.checked,
      ...(append.value.trim() ? { instructionsAppend: append.value.trim() } : {}),
      models: checkedModels,
    };
    const existingSelections = pickerSelectionsExcept(next, providerName);
    applyPickerSelections(next, pickerInput.checked ? [...existingSelections, ...checkedModels.map((model) => ({ ...model, provider: providerName }))] : existingSelections);
    saveButton.disabled = true;
    try { await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); toast(t("common.saved")); await offerPickerOn(pickerInput.checked && checkedModels.length > 0); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  void runProbe();
}

function openGoogleProviderForm(options) {
  let formActive = true;
  const existing = options.provider;
  const nameInput = el("input", { value: options.name || t("providers.google"), maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: existing && existing.apiKey ? t("providers.keySaved") : t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const keyField = el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.googleKeyHelp") })]);
  const auth = el("select", {}, [selectOption("api-key", t("providers.googleAuthApiKey")), selectOption("antigravity", t("providers.googleAntigravity"))]);
  auth.value = (existing && existing.auth) || "api-key";
  const authField = inputRow(t("providers.credentials"), auth, t("providers.googleAuthHelp"));
  const login = el("button", { class: "btn secondary", type: "button", text: t("providers.addGoogleAccount") });
  login.addEventListener("click", async () => {
    login.disabled = true;
    if (await startGoogleLogin()) await runProbe();
    if (formActive) login.disabled = false;
  });
  const loginField = el("div", { class: "form-field" }, [el("span", { text: t("providers.googleLogin") }), login, el("small", { class: "warn-text", text: t("providers.googleWarningShort") })]);
  function syncAuth() {
    keyField.hidden = auth.value !== "api-key";
    loginField.hidden = auth.value !== "antigravity";
  }
  auth.addEventListener("change", syncAuth);
  syncAuth();
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  let foundModels = modelsOf(existing);
  const currentChecked = new Set(foundModels.map((model) => model.id));
  const modelArea = el("div", { class: "form-field" });
  function renderModels(checked, help) {
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(help || t("providers.modelsHelp")), modelChecklist(foundModels, checked, { allowCustom: true }));
  }
  renderModels(currentChecked);
  async function runProbe() {
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    try {
      const body = auth.value === "antigravity" ? { type: "google", auth: "antigravity" } : { type: "google", auth: "api-key", apiKey: keyInput.value.trim() || (existing && existing.apiKey) };
      const response = await api("/api/providers/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!formActive) return;
      const failed = response.auth === "bad-key" ? t("providers.probeBadKey") : response.auth === "missing" && auth.value === "antigravity" ? t("providers.googleSignInFirst") : t("providers.probeFailed");
      result.replaceChildren(...[
        el("span", { class: response.ok ? "ok-text" : "bad-text", text: response.ok ? t("providers.probeOk") : failed }),
        response.error ? el("div", { class: "small", text: response.error }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        const ticked = modelArea.querySelector(".model-picker").selected();
        // The catalogue lists dozens of Gemini variants, so a new provider starts with none ticked
        // rather than all of them; saved and typed picks stay ticked and visible.
        const keep = new Set([...currentChecked, ...ticked.map((model) => model.id)]);
        foundModels = [...ticked.filter((model) => !response.models.some((m) => m.id === model.id)), ...response.models];
        renderModels(keep, t("providers.modelsFoundMany"));
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  const advanced = el("details", { class: "details" }, [el("summary", { text: t("common.advanced") })]);
  const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
  const limitsInput = el("input", { type: "checkbox", checked: !(existing && existing.limits === false) });
  const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
  advanced.appendChild(el("div", { class: "advanced-content" }, [
    el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
    el("div", { class: "form-field" }, [el("label", { class: "check" }, [limitsInput, el("span", { text: t("providers.limits") })]), el("small", { text: t("providers.limitsHelp") })]),
    inputRow(t("providers.append"), append, t("providers.appendHelp")),
  ]));
  const pickerInput = el("input", { type: "checkbox", checked: Boolean(existing && modelsOf(existing).some((model) => ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === model.id))) });
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")), authField, keyField, loginField, probeButton, result, modelArea,
    el("label", { class: "check picker-check" }, [pickerInput, el("span", { text: t("providers.showInPicker") })]),
    pickerModeOn() ? null : hint(t("providers.pickerOffHint")),
    advanced,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const apiKey = auth.value === "api-key" ? keyInput.value.trim() || (existing && existing.apiKey) : undefined;
    const saved = existing && (next.providers[options.name] || existing);
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    // Fields this form has no control for (defaultEffort, a hand-written setting) survive the save.
    const formKeys = new Set(["type", "auth", "apiKey", "identity", "limits", "instructionsAppend", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = {
      ...kept,
      type: "google",
      auth: auth.value,
      ...(apiKey ? { apiKey } : {}),
      ...(existing && existing.url ? { url: existing.url } : {}),
      identity: identity.checked,
      limits: limitsInput.checked,
      ...(append.value.trim() ? { instructionsAppend: append.value.trim() } : {}),
      models: checkedModels,
    };
    // Same rule as the other provider forms: read after the provider is updated, so an unticked
    // model is already undeclared and falls out of the picker on its own.
    const existingSelections = pickerSelectionsExcept(next, providerName);
    applyPickerSelections(next, pickerInput.checked ? [...existingSelections, ...checkedModels.map((model) => ({ ...model, provider: providerName }))] : existingSelections);
    saveButton.disabled = true;
    try { await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = auth.value === "antigravity" ? "accounts" : "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); toast(t("common.saved")); await offerPickerOn(pickerInput.checked && checkedModels.length > 0); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  // An existing provider can already reach its catalogue (a stored key or a signed-in account), so
  // the full list is shown straight away.
  if (existing && (existing.apiKey || existing.auth === "antigravity")) void runProbe();
}
function openProviderForm(options) {
  const existing = options.provider;
  const preset = options.preset || (existing && existing.preset && presetById(existing.preset));
  const isChatgpt = options.kind === "chatgpt" || (existing && existing.type === "chatgpt");
  const isAnthropic = options.kind === "anthropic" || (existing && existing.type === "anthropic");
  const isOpenAi = !isChatgpt && !isAnthropic && ((existing && existing.type === "openai-compatible") || (preset && preset.kind === "openai-compatible"));
  const isCustom = options.kind === "custom";
  const displayName = options.name || (preset && preset.name) || (isChatgpt ? t("providers.chatgpt") : isAnthropic ? t("providers.anthropic") : t("providers.customName"));
  if (isAnthropic) { openAnthropicProviderForm(options); return; }
  if (options.kind === "google" || (existing && existing.type === "google")) { openGoogleProviderForm(options); return; }
  if (options.kind === "grok" || (existing && existing.type === "grok")) { openGrokProviderForm(options); return; }
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const currentHeaders = (existing && existing.headers) || {};
  // The saved auth header is found in any case: a config may spell it "Authorization" while the
  // form writes "authorization", and an exact-case read left `existingKey` empty — saving the form
  // then wrote an empty `headers` over the only key this provider had.
  const savedAuthHeader = authHeaderName(currentHeaders);
  const headerKind = preset ? preset.authHeader : (isOpenAi || (savedAuthHeader && savedAuthHeader.toLowerCase() === "authorization") ? "authorization-bearer" : "x-api-key");
  const existingKey = headerKind === "authorization-bearer" ? String(headerValueOf(currentHeaders, "authorization") || "").replace(/^Bearer\s+/i, "") : headerValueOf(currentHeaders, "x-api-key") || "";
  if (existingKey) keyInput.placeholder = t("providers.keySaved");
  const urlInput = el("input", { value: (existing && existing.url) || (preset && preset.anthropicBaseUrl) || "", placeholder: "https://" });
  const wireSelect = el("select", {}, [selectOption("chat", "Chat Completions"), selectOption("responses", "Responses")]);
  wireSelect.value = (existing && existing.wire) || (preset && preset.wire) || "chat";
  // A provider entered by hand speaks whichever API its docs name, so the form asks instead of
  // assuming Anthropic: an OpenAI-compatible address was saved as Anthropic and tested on
  // /v1/messages, which answered 404 (2026-10-07, reported by a user).
  const formatSelect = el("select", {}, [selectOption("anthropic", "Anthropic Messages"), selectOption("chat", "OpenAI Chat Completions"), selectOption("responses", "OpenAI Responses")]);
  const openAiNow = () => isCustom ? formatSelect.value !== "anthropic" : isOpenAi;
  const wireNow = () => isCustom ? formatSelect.value : wireSelect.value;
  const pickerInput = el("input", { type: "checkbox", checked: Boolean(existing && (existing.models || []).some((model) => {
    const id = typeof model === "string" ? model : model.id;
    return ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === id);
  })) });
  const initialModels = modelsOf(existing).length ? modelsOf(existing) : (preset ? (preset.fallbackModels || []) : (isChatgpt ? CHATGPT_MODELS : []));
  let foundModels = initialModels;
  const currentChecked = new Set(modelsOf(existing).map((model) => model.id));
  // Everything starts ticked only for a new provider. An existing one keeps its saved picks even
  // when that is none: treating "no models" as "not decided yet" re-ticked the whole fallback list
  // every time the form opened, and saving then declared all of them (2026-09-29, opencode-zen).
  const checklistOptions = { allowCustom: !isChatgpt };
  const modelsBox = modelChecklist(foundModels, existing ? currentChecked : new Set(foundModels.map((model) => model.id)), checklistOptions);
  const providerEffortLevels = isChatgpt
    ? effortLevelsFor(options.name || "chatgpt", "gpt-5.6-terra")
    : (existing ? effortLevelsFor(options.name, initialModels[0] && initialModels[0].id) : fallbackEffortLevels({ ...(preset ? { preset: preset.id } : {}), ...(isCustom ? { caps: {} } : {}) }, initialModels[0] && initialModels[0].id));
  const modelArea = el("div", { class: "form-field" }, [
    el("span", { text: t("providers.models") }),
    hint(t("providers.modelsHelp")),
    hasModelEffortData({ models: initialModels }) ? null : el("small", { text: t("providers.effortLevels", { levels: providerEffortLevels.length ? providerEffortLevels.join(" · ") : t("providers.effortNone") }) }),
    modelsBox,
  ]);
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const advanced = el("details", { class: "details" });
  advanced.append(el("summary", { text: t("common.advanced") }));
  const advancedContent = el("div", { class: "advanced-content" });
  let chatgptFields = [];
  if (!isChatgpt) {
    // A hand-entered provider shows the address above, outside this section; one input cannot sit in
    // both places, and this row was left with its label and help but no field.
    if (!isCustom) advancedContent.appendChild(inputRow(t("providers.url"), urlInput, isOpenAi ? t("providers.openaiUrlHelp") : t("providers.urlHelp")));
    if (isOpenAi) advancedContent.appendChild(inputRow(t("providers.wire"), wireSelect, t("providers.wireHelp")));
    if (isCustom) {
      const authSelect = el("select", {}, [selectOption("x-api-key", "x-api-key"), selectOption("authorization-bearer", "Authorization: Bearer")]);
      authSelect.value = headerKind;
      advancedContent.appendChild(inputRow(t("providers.keyType"), authSelect, t("providers.keyTypeHelp")));
      let authPicked = false;
      authSelect.addEventListener("change", () => { authPicked = true; keyInput.dataset.headerKind = authSelect.value; });
      // OpenAI-compatible APIs take the key as a Bearer token, so follow the format until the
      // header has been picked by hand.
      formatSelect.addEventListener("change", () => {
        if (authPicked) return;
        authSelect.value = openAiNow() ? "authorization-bearer" : "x-api-key";
        keyInput.dataset.headerKind = authSelect.value;
      });
    }
    const extraHeaders = el("textarea", { rows: "2", placeholder: "header-name: value" });
    const additional = Object.entries(currentHeaders).filter(([key]) => key.toLowerCase() !== "x-api-key" && key.toLowerCase() !== "authorization");
    extraHeaders.value = additional.map(([key, value]) => `${key}: ${value}`).join("\n");
    // With several keys saved, these headers are part of every key's request (the router merges
    // them with each key's own auth header), so the note says so instead of leaving it to be found.
    const hasKeys = Array.isArray(existing && existing.credentials) && existing.credentials.length > 0;
    advancedContent.appendChild(inputRow(t("providers.extraHeaders"), extraHeaders, hasKeys ? t("providers.extraHeadersKeysHelp") : t("providers.extraHeadersHelp")));
    advancedContent._extraHeaders = extraHeaders;
    // Without a line of its own the model reads Claude Code's system prompt and answers that it is
    // Claude, which is what DeepSeek did before this was offered here too.
    const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
    const limitsInput = el("input", { type: "checkbox", checked: !(existing && existing.limits === false) });
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    advancedContent.append(
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [limitsInput, el("span", { text: t("providers.limits") })]), el("small", { text: t("providers.limitsHelp") })]),
      inputRow(t("providers.append"), append, t("providers.appendHelp")),
    );
    advancedContent._prompt = { identity, limits: limitsInput, append };
  } else {
    const auth = el("select", {}, [selectOption("auto", t("providers.authAuto")), selectOption("own", t("providers.authOwn")), selectOption("borrow-codex", t("providers.authBorrow"))]);
    auth.value = (existing && existing.auth) || "auto";
    const login = el("button", { class: "btn secondary", type: "button", text: t("providers.chatgptLogin") });
    login.addEventListener("click", () => void startChatgptLogin(() => {
      login.disabled = chatgptLoginBusy;
      loginHelp.textContent = chatgptLoginMessage || t("providers.loginHelp");
    }));
    const loginHelp = el("small", { text: t("providers.loginHelp") });
    const effort = effortSelect((existing && existing.defaultEffort) || "high", ["low", "medium", "high", "xhigh", "max"]);
    const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
    const limitsInput = el("input", { type: "checkbox", checked: !(existing && existing.limits === false) });
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    // The Codex fast tier, one switch for the session's own turns and one for a subagent's.
    const fastMain = el("input", { type: "checkbox", checked: Boolean(existing && existing.fast && existing.fast.main === true) });
    const fastSubagent = el("input", { type: "checkbox", checked: Boolean(existing && existing.fast && existing.fast.subagent === true) });
    chatgptFields = [
      inputRow(t("providers.credentials"), auth, t("providers.credentialsHelp")),
      el("div", { class: "form-field" }, [el("span", { text: t("providers.login") }), login, loginHelp]),
      inputRow(t("providers.defaultEffort"), effort, t("providers.defaultEffortHelp")),
      el("div", { class: "form-field" }, [
        el("label", { class: "check" }, [fastMain, el("span", { text: t("providers.fastMain") })]),
        el("label", { class: "check" }, [fastSubagent, el("span", { text: t("providers.fastSubagent") })]),
        el("small", { text: t("providers.fastHelp") }),
      ]),
    ];
    advancedContent.append(
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [limitsInput, el("span", { text: t("providers.limits") })]), el("small", { text: t("providers.limitsHelp") })]),
      inputRow(t("providers.append"), append, t("providers.appendHelp")),
    );
    advancedContent._chatgpt = { auth, effort, identity, limits: limitsInput, append, fastMain, fastSubagent };
  }
  advanced.appendChild(advancedContent);
  const customUrlRow = isCustom ? inputRow(t("providers.url"), urlInput, t("providers.urlHelp")) : null;
  if (isCustom) formatSelect.addEventListener("change", () => {
    customUrlRow.querySelector("small").textContent = openAiNow() ? t("providers.openaiUrlHelp") : t("providers.urlHelp");
  });
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")),
    !isChatgpt ? el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.keyHelp") })]) : null,
    isCustom ? inputRow(t("providers.wire"), formatSelect, t("providers.formatHelp")) : null,
    customUrlRow,
    ...chatgptFields,
    !isChatgpt ? probeButton : null,
    result,
    modelArea,
    el("label", { class: "check picker-check" }, [pickerInput, el("span", { text: t("providers.showInPicker") })]),
    pickerModeOn() ? null : hint(t("providers.pickerOffHint")),
    advanced,
  ]);
  function readHeaders() {
    const headers = {};
    const kind = keyInput.dataset.headerKind || headerKind;
    const key = keyInput.value.replace(/^\s*bearer\s+/i, "").replace(/\s+/g, "");
    if (key) {
      if (kind === "authorization-bearer") headers.authorization = `Bearer ${key}`;
      else headers["x-api-key"] = key;
    } else if (existingKey) {
      // Put the saved key back under the header name it is stored with, whatever its case.
      const savedName = Object.keys(currentHeaders).find((header) => header.toLowerCase() === (kind === "authorization-bearer" ? "authorization" : "x-api-key"));
      if (savedName) headers[savedName] = currentHeaders[savedName];
    }
    const rawHeaders = advancedContent._extraHeaders && advancedContent._extraHeaders.value;
    for (const line of String(rawHeaders || "").split("\n")) {
      const at = line.indexOf(":");
      if (at > 0 && line.slice(0, at).trim()) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return headers;
  }
  function draftProvider() {
    if (isChatgpt) {
      const chat = advancedContent._chatgpt;
      return { type: "chatgpt", auth: chat.auth.value, defaultEffort: chat.effort.value, identity: chat.identity.checked, limits: chat.limits.checked, fast: { main: chat.fastMain.checked, subagent: chat.fastSubagent.checked }, ...(chat.append.value.trim() ? { instructionsAppend: chat.append.value.trim() } : {}) };
    }
    const prompt = advancedContent._prompt;
    const draftHeaders = readHeaders();
    // Nothing in this form clears a key: with no credentials the provider's one key lives in
    // `headers`, an empty auth header here means "unchanged", and a save must never blank it.
    const savesHeaders = !(Array.isArray(existing && existing.credentials) && existing.credentials.length);
    if (existing && savesHeaders && savedAuthHeader && !authHeaderName(draftHeaders)) draftHeaders[savedAuthHeader] = currentHeaders[savedAuthHeader];
    return {
      type: openAiNow() ? "openai-compatible" : "anthropic-compatible",
      url: urlInput.value.trim(),
      ...(prompt ? { identity: prompt.identity.checked, limits: prompt.limits.checked } : {}),
      ...(prompt && prompt.append.value.trim() ? { instructionsAppend: prompt.append.value.trim() } : {}),
      ...(preset ? { preset: preset.id } : {}),
      // A vendor that asks for a session header keys its prompt cache on it, so carry it from the
      // preset rather than leaving the user to discover the bill.
      ...(preset && preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
      ...(openAiNow() ? { wire: wireNow(), caps: { effortLevels: (preset && preset.effortLevels) || [], reasoning: preset && preset.effortLevels && preset.effortLevels.length ? "effort" : "none" } } : {}),
      ...(Object.keys(draftHeaders).length ? { headers: draftHeaders } : {}),
    };
  }
  function probeDraft() {
    const d = draftProvider();
    // A saved provider keeps its keys in `credentials[]`, so the form has no auth header to send.
    // The first usable key's header goes to the probe only; it is never placed in a field. A named
    // saved provider needs no borrow — the router resolves the check's key itself, so the key stays
    // out of the request on this side.
    if (!isChatgpt && !options.name && !authHeaderName(d.headers) && existing) {
      const borrowed = credentialAuthHeader(existing);
      if (borrowed) d.headers = { ...(d.headers || {}), [borrowed.name]: borrowed.value };
    }
    if (preset) { d.modelsUrl = preset.modelsUrl; d.modelsAuthHeader = preset.modelsAuthHeader; d.probeModel = (preset.fallbackModels || [])[0] && preset.fallbackModels[0].id; }
    // With nothing to list models from, test with a model the user ticked rather than a made-up id
    // the provider is bound to refuse.
    else {
      const ticked = modelArea.querySelector(".model-picker").selected();
      if (ticked.length) d.probeModel = ticked[0].id;
      // OpenAI-compatible APIs list their models beside the endpoints, so a hand-entered one need
      // not have every id typed in.
      if (d.type === "openai-compatible" && d.url) d.modelsUrl = `${d.url.replace(/\/+$/, "")}/models`;
    }
    return d;
  }
  async function runProbe() {
    const draft = probeDraft();
    if (!draft.url || !/^https?:\/\//i.test(draft.url)) { toast(t("providers.urlRequired"), true); return; }
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    const temporary = `__new_${Date.now()}`;
    // A draft is still reported under a temporary state key, but it is the saved provider's settings
    // being tested, so the router is told which one: with several keys the key lives in `credentials`
    // and only the router's own copy of the provider has it.
    const response = await probeProvider(temporary, draft, undefined, existing ? options.name : undefined);
    probeButton.disabled = false;
    const noCredits = response.ok && /^no-credits:/.test(response.error || "");
    const headline = noCredits ? t("providers.probeNoCredits") : response.ok ? t("providers.probeOk") : response.auth === "not-entitled" ? t("providers.probeNotEntitled") : response.auth === "bad-key" ? t("providers.probeBadKey") : response.unavailable ? t("providers.apiSoon") : t("providers.probeFailed");
    result.replaceChildren(...[
      el("span", { class: response.ok && !noCredits ? "ok-text" : noCredits ? "warn-text" : "bad-text", text: headline }),
      response.error ? el("div", { class: "small", text: response.error.replace(/^no-credits:\s*/, "") }) : null,
    ].filter(Boolean));
    const listed = Boolean(response.models && response.models.length);
    const ticked = modelArea.querySelector(".model-picker").selected();
    foundModels = listed ? response.models.map((model) => typeof model === "string" ? { id: model, name: model } : model) : (preset ? (preset.fallbackModels || []) : foundModels);
    const keep = existing || foundModels.length > 12 ? new Set([...currentChecked, ...ticked.map((m) => m.id)]) : new Set(foundModels.map((model) => model.id));
    // Saved picks that the provider no longer lists stay visible and ticked so nothing is dropped silently.
    for (const saved of modelsOf(existing)) if (keep.has(saved.id) && !foundModels.some((m) => m.id === saved.id)) foundModels = [saved, ...foundModels];
    // So do ids typed in before the test: the provider's list replacing them would undo the typing.
    for (const typed of ticked) if (!foundModels.some((m) => m.id === typed.id)) { foundModels = [typed, ...foundModels]; keep.add(typed.id); }
    modelArea.querySelector(".model-picker").replaceWith(modelChecklist(foundModels, keep, checklistOptions));
    const listHint = listed ? (foundModels.length > 12 ? t("providers.modelsFoundMany") : t("providers.modelsFound")) : preset ? t("providers.modelsFallback") : t("providers.customModelHint");
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(listHint), modelArea.querySelector(".model-picker") || document.createTextNode(""));
  }
  probeButton && probeButton.addEventListener("click", runProbe);
  // Editing a provider that can list models: fetch the full list right away so the saved picks are
  // shown among everything available, not as a two-entry list.
  if (existing && !isChatgpt && preset && preset.modelsUrl && existingKey) setTimeout(() => void runProbe(), 0);
  // ChatGPT has no key field and no probe button, so without this the list stayed the built-in
  // fallback and a model OpenAI shipped after this release never appeared. Ask the backend for its
  // catalogue in the background: ticks survive, new models arrive unticked, and a failure just
  // leaves the fallback list standing.
  let formActive = true;
  if (isChatgpt) {
    const chat = advancedContent._chatgpt;
    void (async () => {
      let response;
      try {
        response = await api("/api/providers/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "chatgpt", auth: chat.auth.value, name: options.name }),
        });
      } catch { return; }
      if (!formActive || !Array.isArray(response.models) || !response.models.length) return;
      // Captured while the fetched list is checked, not against the fallback it is about to replace.
      const keep = new Set([...currentChecked, ...modelArea.querySelector(".model-picker").selected().map((model) => model.id)]);
      // A model the catalogue no longer lists but the config still names stays visible and ticked,
      // so a save cannot drop it silently.
      const named = new Set(response.models.map((model) => model.id));
      foundModels = [...response.models, ...foundModels.filter((saved) => !named.has(saved.id))];
      modelArea.querySelector(".model-picker").replaceWith(modelChecklist(foundModels, keep));
      modelArea.replaceChildren(
        el("span", { text: t("providers.models") }),
        hint(t("providers.modelsHelp")),
        hint(t("providers.modelsFoundLive", { n: response.models.length })),
        modelArea.querySelector(".model-picker"),
      );
    })();
  }
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const provider = draftProvider();
    if (!isChatgpt && (!provider.url || !/^https?:\/\//i.test(provider.url))) { toast(t("providers.urlRequired"), true); return; }
    // Same base URL = the same service. Adding a provider at an address one already answers on
    // would split that service's keys into two pools and two rotations, so the key joins the
    // provider that is already there instead of making a twin. Only a new provider can merge;
    // editing one keeps its own identity.
    if (!existing && isKeyBasedProvider(provider)) {
      const typedKey = keyValueOf(keyInput.value);
      const twin = providerByBaseUrl((currentConfig && currentConfig.providers) || {}, provider.url);
      if (twin && !typedKey) { toast(t("providers.existingNeedsKey", { name: twin[0] }), true); return; }
      if (twin && typedKey) {
        // Only the key travels: the router drops the spaces itself, without saying so, which turned
        // a key pasted with its label into a silent wrong one. Refuse it here like the add-key dialog.
        if (keyHasSpaces(keyInput.value)) { toast(t("keys.spaces"), true); return; }
        saveButton.disabled = true;
        try {
          await api(`/api/provider-keys?provider=${encodeURIComponent(twin[0])}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: typedKey, ...(typedName ? { label: typedName } : {}) }),
          });
          closeModal();
          slotsLoaded = false;
          providersLoaded = false;
          await afterKeyAdded(twin[0], { notice: t("providers.addedToExisting", { name: twin[0] }) });
        } catch (error) {
          saveButton.disabled = false;
          toast(t("common.saveFailed"), true, keyErrorMessage(error));
        }
        return;
      }
    }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers, provider.url);
    const saved = existing && (next.providers[options.name] || existing);
    if (existing && providerName !== options.name) delete next.providers[options.name];
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    provider.models = checkedModels;
    // The form rebuilds the provider from its own fields, so anything it has no field for
    // (debugDump, a hand-written setting) is carried over from the saved one rather than dropped.
    // A field the form owns is left to the draft, so clearing it in the form still clears it.
    const formKeys = new Set(isChatgpt
      ? ["type", "auth", "defaultEffort", "identity", "limits", "instructionsAppend", "fast", "models"]
      : ["type", "url", "identity", "limits", "instructionsAppend", "preset", "sessionHeader", "wire", "caps", "headers", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = { ...kept, ...provider };
    // Read after `next.providers` has been updated, so an unticked model is already undeclared here
    // and falls out on its own, and a renamed provider answers to its new name.
    const existingSelections = pickerSelectionsExcept(next, providerName);
    if (pickerInput.checked) {
      applyPickerSelections(next, [...existingSelections, ...checkedModels.map((model) => ({ ...model, provider: providerName }))]);
    } else {
      applyPickerSelections(next, existingSelections);
    }
    saveButton.disabled = true;
    try {
      await configRequest(next);
      currentConfig = next;
      selectedProviderName = providerName;
      providerDetailTab = "overview";
      slotsLoaded = false;
      providersLoaded = false;
      closeModal();
      await loadProviders();
      toast(t("common.saved"));
      await offerPickerOn(pickerInput.checked && checkedModels.length > 0);
      // Detached on purpose. Measuring asks every ticked model several questions, which is far
      // longer than a save should take, and a model whose wire is still unknown works exactly as it
      // did before — it is only unmeasured. The result lands in the config when it arrives.
      void startMeasurement(providerName, next.providers[providerName]);
    } catch (error) {
      toast(t("common.saveFailed"), true, error.message);
    } finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { if (isChatgpt) formActive = false; });
}

// ---- ClaudeRipple mod ---------------------------------------------------------------
//
// The mod's settings live in the router (GET/PUT /api/mod-settings); the ⚙ panel in the bar edits
// the same object. As in System Settings a change applies itself: it is saved after a short pause
// with the revision it was made on. A 409 means another surface saved first: the fields changed
// here are laid over its settings and sent again, so neither side's change is lost.

const MOD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// The band's parts the person can turn off (`hide`), then the ones it shows only when turned on
// (`extras`, as the mod's settings.ts EXTRAS): the judge's reason is in the effort's tip alone.
const MOD_PARTS = ["timer", "route"];
const MOD_EXTRAS = ["context", "limits"];
// Named in themselves, as the mod's own Look card lists them.
const MOD_LANGUAGES = [["ko", "한국어"], ["en", "English"], ["zh", "简体中文"], ["ja", "日本語"], ["es", "Español"], ["pt", "Português"]];
// Claude Code's own agent with a model: what the mod offers besides the generated workers, smallest
// first, and their current model ids (packages/mod/hooks/settings.ts CLAUDE_WORKERS).
const MOD_CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"];
const MOD_CLAUDE_IDS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" };
// The four workers, low to max (the mod's rung ids: light, standard, hard, plan).
const MOD_RUNGS = ["light", "standard", "hard", "plan"];
// A domain ladder has two levels: the light pair (light+standard) and the heavy pair (hard+plan).
const MOD_DOMAIN_LEVELS = [
  { key: "light", rungs: ["light", "standard"] },
  { key: "heavy", rungs: ["hard", "plan"] },
];
const modClaude = (model, effort) => ({ target: { agent: "general-purpose", model }, effort });
/** The mod's defaults (packages/mod/hooks/settings.ts), for a router that has stored nothing yet. */
const MOD_DEFAULTS = {
  effortAuto: true, judge: "haiku", judgeModel: "deepseek-v4.1-flash", jevSource: "typesafe",
  bias: 0, floor: "low", ceiling: "max", agentAuto: "auto",
  rules: {
    general: { mode: "ladder", rungs: {
      light: [{ target: { agent: "deepseek-v4-1-flash" }, effort: "max" }], standard: [{ target: { agent: "gpt-6-1-sol" }, effort: "medium" }],
      hard: [{ target: { agent: "gpt-6-astra" }, effort: "high" }], plan: [modClaude("opus", "high")],
    } },
  },
  allow: [], allowKnown: [], modes: [], delegation: "normal", providers: {},
  fallback: { agent: "general-purpose", model: "sonnet" },
  keepWarm: false, keepWarmHours: 2, keepWarmMinTokens: 30000,
  compactWith: "haiku", handoffSkill: "", handoffAfter: "continue", handoffButton: "advised",
  swampAt: 50, layout: "dashboard", appearance: "auto", skin: "deep", language: "auto", hide: ["reason"], extras: [], setupDone: false,
};

// `base` is the router's copy `settings` was edited from: what differs between them is this page's own change.
let modState = { settings: null, base: null, revision: 0, options: null, retiredNote: false };
let modSaveTimer = null;
let modSaving = false;
let modSaveAgain = false;
// Counts the router's answers to saves, so a read that went out before one does not undo it.
let modWrites = 0;

/**
 * The router hands back the mod's full normalized settings; this only fills what an older router
 * (or an empty store) leaves out, so the page never draws a control over `undefined`. Fields this
 * page does not know are kept and sent back as they came.
 */
function modNormalize(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? clone(raw) : {};
  return {
    ...clone(MOD_DEFAULTS),
    ...value,
    rules: { ...clone(MOD_DEFAULTS.rules), ...(value.rules || {}) },
    allow: Array.isArray(value.allow) ? value.allow : [],
    allowKnown: Array.isArray(value.allowKnown) ? value.allowKnown : [],
    modes: Array.isArray(value.modes) ? value.modes : [],
    providers: { ...(value.providers || {}) },
    hide: Array.isArray(value.hide) ? value.hide : clone(MOD_DEFAULTS.hide),
  };
}

/**
 * The fields changed from `before` to `after`, found as the mod's settingsChanges finds them: values
 * and arrays whole, objects field by field, and a rule whose mode changed replaced whole.
 */
function modChanges(before, after, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (after === undefined) return [{ path, remove: true }];
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObject(before) && isObject(after) && before.mode === after.mode) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => modChanges(before[key], after[key], [...path, key]));
  }
  return [{ path, value: after }];
}
function modApply(base, changes) {
  const result = clone(base);
  for (const change of changes) {
    const key = change.path.at(-1);
    if (key === undefined) continue;
    let parent = result;
    for (const step of change.path.slice(0, -1)) {
      if (!parent[step] || typeof parent[step] !== "object" || Array.isArray(parent[step])) parent[step] = {};
      parent = parent[step];
    }
    if (change.remove) delete parent[key];
    else parent[key] = clone(change.value);
  }
  return result;
}
/** Take the router's copy, keeping on it what was changed here and is not saved yet (unless `drop`). */
function modAdopt(snapshot, drop) {
  const changes = !drop && modState.base && modState.settings ? modChanges(modState.base, modState.settings) : [];
  modState.base = modNormalize(snapshot.settings);
  modState.settings = modApply(modState.base, changes);
  modState.revision = Number(snapshot.revision) || 0;
}

function modCap(text) { return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text; }
function modEffortName(effort) { return t(`mod.effort.${effort}`); }
function modSigned(n) { return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0"; }
function modTargetValue(target) { return target && target.agent ? (target.model ? `${target.agent}+${target.model}` : target.agent) : ""; }
function modTargetOf(value) {
  const plus = value.indexOf("+");
  return plus < 0 ? { agent: value } : { agent: value.slice(0, plus), model: value.slice(plus + 1) };
}
function modAgents() { return (modState.options && modState.options.agents) || []; }
function modProviderInfo(name) { return ((modState.options && modState.options.providers) || []).find((provider) => provider.name === name); }
function modModels() {
  const seen = new Set();
  return ((modState.options && modState.options.models) || []).filter((model) => !model.judgeOnly && !seen.has(model.model) && seen.add(model.model));
}

/** Rebuild a region in place, keeping keyboard focus on the control that had it. */
function modRedraw(root, nodes) {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.dataset.key : null;
  root.replaceChildren(...nodes.filter(Boolean));
  if (key) {
    const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again) again.focus();
  }
}
function modSwitch(key, checked, label, onChange) {
  const input = el("input", { type: "checkbox", role: "switch", "data-key": key, "aria-label": label, checked });
  input.addEventListener("change", () => onChange(input.checked));
  return el("span", { class: "switch" }, [input, el("span")]);
}
function modSegmented(key, choices, value, label, onPick) {
  return el("div", { class: "segmented", role: "radiogroup", "aria-label": label }, choices.map((choice) => {
    const on = String(choice.value) === String(value);
    const button = el("button", { type: "button", class: on ? "active" : "", role: "radio", "aria-checked": String(on), "data-key": `${key}:${choice.value}`, text: choice.label, ...(choice.disabled ? { disabled: "" } : {}) });
    button.addEventListener("click", () => { if (!on) onPick(choice.value); });
    return button;
  }));
}
/** A pop-up menu. Items are `{value, label}` or `{group, items}`; a saved value no longer offered stays visible. */
function modSelect(key, items, value, label, onChange, cls) {
  const select = el("select", { "data-key": key, "aria-label": label, class: cls });
  const known = new Set();
  const add = (parent, item) => { known.add(String(item.value)); parent.appendChild(el("option", { value: item.value, text: item.label })); };
  for (const item of items) {
    if (!item.group) { add(select, item); continue; }
    if (!item.items.length) continue;
    const group = el("optgroup", { label: item.group });
    for (const entry of item.items) add(group, entry);
    select.appendChild(group);
  }
  if (!known.has(String(value))) select.appendChild(el("option", { value, text: `${value}${t("mod.unavailable")}` }));
  select.value = String(value);
  select.addEventListener("change", () => onChange(select.value));
  return select;
}
function modSection(title, rows, footers, action) {
  return el("section", { class: "section" }, [
    title || action ? el("div", { class: "section-head" }, [title ? el("h3", { class: "section-title", text: title }) : el("span"), action || null]) : null,
    el("div", { class: "group" }, rows.filter(Boolean)),
    ...(footers || []).filter(Boolean).map((footer) => typeof footer === "string" ? el("p", { class: "group-footer", text: footer }) : footer),
  ]);
}
function modCard(id, title, blurb, sections) {
  return el("section", { class: "mod-card", "aria-labelledby": `mod-card-${id}` }, [
    el("div", { class: "mod-card-head" }, [el("h2", { id: `mod-card-${id}`, text: title }), blurb ? el("p", { class: "hint", text: blurb }) : null]),
    ...sections.filter(Boolean),
  ]);
}
// ---- Saving

function modStatus(text, isError) {
  const box = $("#mod-status");
  box.textContent = text;
  box.classList.toggle("bad-text", Boolean(isError));
}
function modPatch(change) {
  modState.settings = { ...modState.settings, ...change };
  modRefresh();
  clearTimeout(modSaveTimer);
  modStatus(t("slots.saving"));
  modSaveTimer = setTimeout(() => { modSaveTimer = null; void saveMod(); }, 450);
}
function modSetRule(domain, rule) { modPatch({ rules: { ...modState.settings.rules, [domain]: rule } }); }
async function saveMod() {
  if (modSaving) { modSaveAgain = true; return; }
  modSaving = true;
  try {
    // Another surface saving first (the bar's ⚙ panel, another tab of this page) costs this change
    // nothing: it is laid over their settings and sent again. Only a router that keeps moving under
    // it, three times running, gets the change dropped.
    for (let attempt = 1; ; attempt++) {
      const sent = clone(modState.settings);
      let out;
      try {
        out = await api("/api/mod-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, settings: sent, revision: modState.revision }) });
      } catch (error) {
        if (error.status !== 409 || !error.body || !("settings" in error.body)) throw error;
        modWrites++;
        if (attempt < 3) { modAdopt(error.body); modRefresh(); continue; }
        clearTimeout(modSaveTimer);
        modSaveTimer = null;
        modSaveAgain = false;
        modAdopt(error.body, true);
        modRefresh();
        modStatus(t("mod.conflict"), true);
        toast(t("mod.conflict"), true);
        return;
      }
      modWrites++;
      modState.revision = Number(out.revision) || modState.revision + 1;
      // The router's copy is the normalized one; take it unless a newer change is already waiting.
      if (out.settings && !modSaveTimer && !modSaveAgain) { modAdopt(out, true); modRefresh(); }
      else modState.base = sent;
      modStatus(t("mod.saved"));
      return;
    }
  } catch (error) {
    modStatus(`${t("common.saveFailed")} ${error.message}`, true);
  } finally {
    modSaving = false;
    if (modSaveAgain) { modSaveAgain = false; void saveMod(); }
  }
}
async function loadMod() {
  // A save on its way brings back the router's copy itself.
  if (modSaveTimer || modSaving) return;
  let retired = false;
  const writes = modWrites;
  const [settingsResult, optionsResult] = await Promise.allSettled([api("/api/mod-settings"), api("/api/mod-options")]);
  if (settingsResult.status === "rejected") {
    if (!modState.settings) {
      $("#mod-content").replaceChildren(modSection(null, [el("div", { class: "cell-note bad-text", text: `${t("common.loadFailed")} ${settingsResult.reason.message}` })]));
      return;
    }
  } else if (!modSaving && modWrites === writes) {
    // A change made while this read was out stays on top of what it brought. One already saved, or
    // being saved, has the router's newer answer from that save instead.
    modAdopt(settingsResult.value);
    retired = settingsResult.value.legacy === true;
  }
  modState.options = optionsResult.status === "fulfilled" ? optionsResult.value : null;
  await modLoadResets();
  if (retired) modState.retiredNote = true;
  modRefresh();
  // The settings came back without Auto and the field rules; saving them as they are keeps the note to this once.
  if (retired) modPatch({});
}
// Back on this page after a while: the bar's ⚙ panel or another tab may have saved meanwhile.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && $("#view-mod").classList.contains("active")) void loadMod();
});
function modRefresh() {
  if (!modState.settings) return;
  renderModNotice();
  modRedraw($("#mod-content"), [modEffortCard(), modWorkersCard(), modJudgeCard(), modCacheCard(), modHandoffCard(), modLookCard()]);
}
/** Settings for a mod that is switched off do nothing until it is on; the switch lives in Clients. */
function renderModNotice() {
  const box = $("#mod-notice");
  const off = Boolean(status) && !status.statusMod;
  if (box.dataset.state === String(off)) return;
  box.dataset.state = String(off);
  box.hidden = !off;
  box.replaceChildren(...(off ? [el("div", { class: "group" }, [cell(
    el("span", { class: "cell-label", text: t("mod.offNotice", { clients: t("nav.clients") }) }),
    el("button", { class: "btn secondary compact", type: "button", text: t("nav.clients"), onclick: () => showView("clients") }),
  )])] : []));
}

// ---- Cards

function modEffortCard() {
  const s = modState.settings;
  const efforts = MOD_EFFORTS.map((effort) => ({ value: effort, label: modEffortName(effort) }));
  const range = el("input", { type: "range", class: "lean-range", min: "-2", max: "2", step: "1", value: String(s.bias), "data-key": "bias", "aria-label": t("mod.lean"), "aria-valuetext": modSigned(s.bias) });
  range.addEventListener("change", () => modPatch({ bias: Number(range.value) }));
  const lean = el("div", { class: "lean" }, [
    el("span", { class: "lean-end", text: t("mod.cheaper") }),
    el("div", { class: "lean-track" }, [range, el("div", { class: "lean-ticks", "aria-hidden": "true" }, [-2, -1, 0, 1, 2].map(() => el("span")))]),
    el("span", { class: "lean-end", text: t("mod.smarter") }),
  ]);
  const inverted = MOD_EFFORTS.indexOf(s.ceiling) < MOD_EFFORTS.indexOf(s.floor);
  return modCard("effort", t("mod.effort"), t("mod.effortBlurb"), [modSection(null, [
    cell(t("mod.auto"), modSwitch("effort-auto", s.effortAuto, t("mod.auto"), (on) => modPatch({ effortAuto: on })), modCap(t("mod.autoHint"))),
    cell(t("mod.lean"), lean, modCap(t("mod.leanHint")), "wide"),
    cell(t("mod.floor"), modSelect("floor", efforts, s.floor, t("mod.floor"), (floor) => modPatch({ floor }), "narrow")),
    cell(t("mod.ceiling"), modSelect("ceiling", efforts, s.ceiling, t("mod.ceiling"), (ceiling) => modPatch({ ceiling }), "narrow"), inverted ? el("span", { class: "cell-sub warn-text", text: modCap(t("mod.floorWins")) }) : null),
  ])]);
}

// ---- The four workers (docs/specs/2026-10-12-worker-tiers.md)

/**
 * Everything a worker can run: the router's workers (each with its model's effort ladder and how it
 * is paid for), Claude Code's own agent on each Claude model, and the session's own model.
 */
function modChoices() {
  const options = modState.options || {};
  const claudeEfforts = Array.isArray(options.claudeEfforts) && options.claudeEfforts.length ? options.claudeEfforts : ["low", "medium", "high", "xhigh", "max"];
  const workers = modAgents().map((agent) => {
    const info = modProviderInfo(agent.provider);
    return {
      value: agent.name, label: agent.model, model: agent.model, provider: agent.provider,
      billing: /(?::|-)free$/i.test(agent.model) ? "free" : agent.billing || (info && info.billing) || null,
      usable: !info || info.usable !== false,
      efforts: Array.isArray(agent.efforts) ? agent.efforts : effortLevelsFor(agent.provider, agent.model),
    };
  });
  const claude = MOD_CLAUDE_MODELS.map((alias) => ({
    value: `general-purpose+${alias}`, label: `Claude ${modCap(alias)}`, model: MOD_CLAUDE_IDS[alias], provider: "anthropic",
    billing: "subscription", usable: true, efforts: claudeEfforts, claude: true,
  }));
  const session = { value: "general-purpose", label: t("mod.sessionModel"), model: null, provider: null, billing: null, usable: true, efforts: claudeEfforts, claude: true };
  return [...workers, ...claude, session];
}
function modChoiceOf(target) { const value = modTargetValue(target); return modChoices().find((choice) => choice.value === value); }
/** The efforts a model takes, in the mod's terms; an unknown ladder offers them all. */
function modLadderOf(choice) {
  const levels = choice && Array.isArray(choice.efforts) ? choice.efforts.filter((effort) => MOD_EFFORTS.includes(effort)) : [];
  return levels.length ? levels : [...MOD_EFFORTS];
}
/** The nearest effort a model takes, ties going up: how the router clamps one (compat.ts). */
function modNearest(effort, ladder) {
  if (ladder.includes(effort)) return effort;
  const at = MOD_EFFORTS.indexOf(effort);
  return ladder.reduce((best, next) => {
    const d = Math.abs(MOD_EFFORTS.indexOf(next) - at);
    const bd = Math.abs(MOD_EFFORTS.indexOf(best) - at);
    return d < bd || (d === bd && MOD_EFFORTS.indexOf(next) > MOD_EFFORTS.indexOf(best)) ? next : best;
  });
}
/** The group a model sits in: its provider, Claude's own together. */
function modGroupName(choice) { return choice.claude ? "Claude" : choice.provider; }
/** Choices in provider groups, each group tagged free / pay-per-token / subscription. */
function modGroups(choices) {
  const groups = [];
  for (const choice of choices) {
    const name = modGroupName(choice);
    let group = groups.find((entry) => entry.name === name);
    if (!group) { group = { name, billing: choice.billing, items: [] }; groups.push(group); }
    group.items.push(choice);
  }
  return groups;
}
function modGroupLabel(group) { return group.billing ? `${group.name} · ${t(`mod.billing.${group.billing}`)}` : group.name; }

// ---- The models to use: what the four workers are filled from and may run on

/** An allow-list key: a worker's agent name, or `general-purpose:<model>` for Claude's own. */
function modTickKey(choice) { return choice.claude ? choice.value.replace("+", ":") : choice.value; }
/** The models that can be ticked: every worker and Claude's own; the session's model is always there. */
function modTickable() { return modChoices().filter((choice) => choice.value !== "general-purpose"); }
/** Whether a model is ticked: an empty list means every model, an old provider name ticks that provider's, and a model added after the list was last written (absent from `allowKnown`) ticks on. */
function modTicked(choice) {
  const allow = modState.settings.allow || [];
  const known = modState.settings.allowKnown || [];
  return !allow.length || allow.includes(modTickKey(choice)) || allow.includes(choice.provider) || known.length > 0 && !known.includes(modTickKey(choice));
}
/** Ticks one model; every model on again is stored as [], and the last one on cannot go off. */
function modTick(choice, on) {
  const all = modTickable();
  const known = all.map(modTickKey);
  const kept = new Set(all.filter((model) => modTicked(model)).map(modTickKey));
  if (on) kept.add(modTickKey(choice)); else kept.delete(modTickKey(choice));
  const allow = kept.size === known.length ? [] : known.filter((key) => kept.has(key));
  modPatch({ allow, allowKnown: allow.length ? known : [] });
}
function modTickRows() {
  const choices = modTickable();
  if (!choices.length) return [el("div", { class: "cell-note", text: t("mod.noModels") })];
  const onCount = choices.filter(modTicked).length;
  return modGroups(choices).map((group) => {
    const boxes = group.items.map((choice) => {
      const on = modTicked(choice);
      const input = el("input", { type: "checkbox", "data-key": `tick:${modTickKey(choice)}`, "aria-label": `${choice.label} · ${group.name}`, checked: on });
      if (on && onCount === 1) input.disabled = true;
      input.addEventListener("change", () => modTick(choice, input.checked));
      // A model paid differently from its group (a :free model on a paid provider) says so beside its name.
      const other = choice.billing && choice.billing !== group.billing ? el("span", { class: "model-effort-tag", text: t(`mod.billing.${choice.billing}`) }) : null;
      const off = choice.usable ? null : el("span", { class: "model-effort-tag warn-text", text: t("mod.notUsable") });
      return el("label", { class: "model-check", title: choice.model || choice.label }, [input, el("span", { text: choice.label }), other, off]);
    });
    return el("div", { class: "tick-group" }, [el("div", { class: "tick-head", text: modGroupLabel(group) }), el("div", { class: "model-checklist" }, boxes)]);
  });
}

// ---- The four workers: a meaning, the pick, and one menu to change it

/** The general ladder's rungs; the router fills any that are empty, so a missing one is only a failed load. */
function modRungs() {
  const general = modState.settings.rules.general;
  return general && general.mode === "ladder" && general.rungs ? general.rungs : {};
}
/** A domain ladder folded into two levels: light+standard hold one list, hard+plan another.
 * The upper rung of each pair wins; an empty upper rung falls back to the lower. */
function modTwoLevelRungs(rungs) {
  const out = {};
  const light = rungs.standard && rungs.standard.length ? rungs.standard : rungs.light;
  const heavy = rungs.plan && rungs.plan.length ? rungs.plan : rungs.hard;
  if (light && light.length) { out.light = clone(light); out.standard = clone(light); }
  if (heavy && heavy.length) { out.hard = clone(heavy); out.plan = clone(heavy); }
  return out;
}
/** One menu of `model · effort` for the ticked models, effort limited to what each model takes; the session's model too. */
function modPickSelect(key, step, shown, label, onPick) {
  const choices = modChoices().filter((choice) => choice.value === "general-purpose" || modTicked(choice));
  const groups = modGroups(choices).map((group) => ({
    group: modGroupLabel(group),
    items: group.items.flatMap((choice) => modLadderOf(choice).map((effort) => ({ value: `${choice.value}|${effort}`, label: `${choice.label} · ${modEffortName(effort)}${choice.usable ? "" : t("mod.unavailableNow")}` }))),
  }));
  const current = step ? `${modTargetValue(step.target)}|${shown}` : "";
  const items = [...(step ? [] : [{ value: "", label: "—" }]), ...groups];
  // A pick that is not on offer now (its model unticked, or gone) keeps showing rather than a wrong neighbour.
  if (step && !groups.some((group) => group.items.some((item) => item.value === current))) {
    const choice = modChoiceOf(step.target);
    items.unshift({ value: current, label: `${choice ? choice.label : modTargetValue(step.target)} · ${modEffortName(shown)}${t("mod.unavailable")}` });
  }
  return modSelect(key, items, current, label, (value) => {
    if (!value) return;
    const bar = value.lastIndexOf("|");
    onPick(modTargetOf(value.slice(0, bar)), value.slice(bar + 1));
  }, "rung-model");
}
/** @typedef {"general" | "ui" | "backend"} WorkerRuleKey */
/** Domain selection is local UI state, independently retained for each saved worker set.
 * @type {Map<string, WorkerRuleKey>}
 */
const modRuleTabs = new Map();
/** Save only this set's optional rule; deleting it makes the set follow its own general ladder.
 * @param {import("../mod/types").Mode | undefined} mode
 * @param {"ui" | "backend"} key
 * @param {import("../mod/types").Rule | undefined} rule
 */
function modSetDomainRule(mode, key, rule) {
  const domainRules = { ...(mode || modState.settings).domainRules };
  if (rule) domainRules[key] = rule;
  else delete domainRules[key];
  const change = { domainRules: Object.keys(domainRules).length ? domainRules : undefined };
  if (mode) modUpdateMode(mode.id, change);
  else modPatch(change);
}
/** @param {import("../mod/types").Mode} [mode] */
function modWorkerRows(mode) {
  const id = mode ? mode.id : "base";
  const key = modRuleTabs.get(id) || "general";
  const rule = key === "general" ? null : (mode || modState.settings).domainRules?.[key];
  const rows = [cell(t("mod.workerDomain"), modSegmented(`worker-domain:${id}`, [
    { value: "general", label: t("mod.domain.general") },
    { value: "ui", label: t("mod.domain.ui") },
    { value: "backend", label: t("mod.domain.backend") },
  ], key, t("mod.workerDomain"), (value) => { modRuleTabs.set(id, value); modRefresh(); }), null, "wide")];
  if (key !== "general") rows.push(cell(t("mod.domainSeparate"), modSwitch(`worker-separate:${id}:${key}`, !!rule, t("mod.domainSeparate"), (on) => {
    // Switching on copies the set's general rungs, folded the same way a domain ladder is.
    modSetDomainRule(mode, key, on ? { mode: "ladder", rungs: modTwoLevelRungs(mode ? mode.rungs : modRungs()) } : undefined);
  }), rule ? (key === "ui" ? t("mod.domainDesignNote") : null) : t("mod.domainFollowsGeneral"), "wide"));
  if (key === "general" || rule) rows.push(...modRungRows(mode, key));
  return rows;
}
/** One rung row: the ordered model·effort list of a rung, with reorder, remove and add.
 * @param {import("../mod/types").Mode | undefined} mode
 * @param {WorkerRuleKey} ruleKey
 * @param {string} rowKey the row's own key (its part in the data-keys)
 * @param {string} name the row's label
 * @param {string} hintKey the i18n key of the line under it
 * @param {import("../mod/types").Step[]} steps the list it shows
 * @param {(next: import("../mod/types").Step[]) => void} save writes the list back
 */
function modRungRow(mode, ruleKey, rowKey, name, hintKey, steps, save) {
  const key = `worker:${mode ? mode.id : "base"}:${ruleKey}:${rowKey}`;
  const rows = steps.map((step, index) => {
    const choice = modChoiceOf(step.target);
    const shown = modNearest(step.effort, modLadderOf(choice));
    const select = modPickSelect(`${key}:${index}`, step, shown, `${name} ${index + 1}`, (target, effort) => save(steps.map((item, at) => at === index ? { target, effort } : item)));
    const move = (delta) => { const next = [...steps]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; save(next); };
    const button = (suffix, text, label, disabled, onclick) => el("button", { type: "button", class: "btn secondary compact", "data-key": `${key}:${suffix}`, text, "aria-label": label, ...(disabled ? { disabled: "" } : {}), onclick });
    return el("li", { class: "rung-item" }, [
      select,
      el("div", { class: "rung-actions" }, [
        button("up", "↑", t("mod.modeMoveUp"), index === 0, () => move(-1)),
        button("down", "↓", t("mod.modeMoveDown"), index === steps.length - 1, () => move(1)),
        button("remove", "✕", t("common.remove"), steps.length <= 1, () => save(steps.filter((_, at) => at !== index))),
      ]),
      choice && !choice.usable ? el("small", { class: "warn-text", text: t("mod.rungUnusable") }) : null,
    ]);
  });
  const add = el("button", { type: "button", class: "btn secondary compact", "data-key": `worker-add:${mode ? mode.id : "base"}:${ruleKey}:${rowKey}`, text: t("mod.modeAddModel"), onclick: () => {
    const choice = modChoices().find((item) => item.value !== "general-purpose" && modTicked(item)) || modChoices().at(-1);
    save([...steps, { target: modTargetOf(choice.value), effort: modNearest("medium", modLadderOf(choice)) }]);
  } });
  return cell(el("span", { class: "cell-label strong", text: name }), el("div", { class: "rung-list" }, [el("ol", {}, rows), add]), modCap(t(hintKey)), "wide rung-row");
}
/** The same ordered-rung editor for the selected rule in Base or a saved mode: the general ladder
 * keeps its four rungs, a domain ladder its two levels.
 * @param {import("../mod/types").Mode | undefined} mode
 * @param {WorkerRuleKey} [ruleKey]
 */
function modRungRows(mode, ruleKey = "general") {
  if (ruleKey !== "general") {
    const rungs = (mode || modState.settings).domainRules[ruleKey].rungs;
    return MOD_DOMAIN_LEVELS.map((level) => {
      // The pair's upper rung shows the list; an edit writes it to both rungs of the pair.
      const upper = level.rungs[1];
      const steps = rungs[upper] && rungs[upper].length ? rungs[upper] : (rungs[level.rungs[0]] || []);
      const save = (next) => {
        const updated = { ...rungs, [level.rungs[0]]: clone(next), [upper]: clone(next) };
        modSetDomainRule(mode, ruleKey, { mode: "ladder", rungs: updated });
      };
      return modRungRow(mode, ruleKey, level.key, t(`mod.domainLevel.${level.key}`), `mod.domainHint.${ruleKey}.${level.key}`, steps, save);
    });
  }
  const rungs = mode ? mode.rungs : modRungs();
  return MOD_RUNGS.map((rung) => {
    const save = (next) => {
      const updated = { ...rungs, [rung]: next };
      if (mode) modUpdateMode(mode.id, { rungs: updated });
      else modSetRule("general", { mode: "ladder", rungs: updated });
    };
    return modRungRow(mode, ruleKey, rung, t(`mod.rung.${rung}`), `mod.rungHint.${rung}`, rungs[rung] || [], save);
  });
}
/** Said once after settings that still held Auto or field rules are read: they became the four workers. */
function modRetiredNote() {
  const close = el("button", { class: "btn secondary compact", type: "button", "data-key": "retired-ok", text: t("common.close"), onclick: () => { modState.retiredNote = false; modRefresh(); } });
  return modSection(null, [cell(el("span", { class: "cell-label", text: t("mod.retired") }), close, null, "offer-row")]);
}
// ---- Operating modes (docs/specs/2026-10-12-worker-tiers.md "Operating modes")
//
// A tab edits a saved worker set; activation is always an explicit, separate action.
let modModeTab = "";
/** Providers a mode can end at the reset of, known now: ChatGPT ones, then Claude ('anthropic'). */
let modResetProviders = [];

/** Only actual future reset timestamps enable the option, never a provider type alone. */
function modQuotaKnown(accounts, binding = false) {
  return (accounts || []).some((account) => {
    if (account.state === "paused" || account.state === "needs-login") return false;
    const quota = account.quota || {};
    const windows = Object.values(quota.rate_limits || {}).filter(Boolean);
    const selected = binding ? windows.sort((a, b) => (b.used_percent || 0) - (a.used_percent || 0)).slice(0, 1) : windows;
    return selected.some((window) => {
      if (!window) return false;
      const at = typeof window.reset_at === "number" ? window.reset_at * (window.reset_at > 1e12 ? 1 : 1000)
        : typeof window.reset_after_seconds === "number" && typeof quota.at === "number" ? quota.at + window.reset_after_seconds * 1000 : NaN;
      return Number.isFinite(at) && at > Date.now();
    });
  });
}
async function modLoadResets() {
  const providers = (modState.options && modState.options.providers) || [];
  const chatgpt = await Promise.all(providers.filter((provider) => provider.type === "chatgpt").map(async (provider) => {
    try {
      const body = await api(`/api/chatgpt-accounts?provider=${encodeURIComponent(provider.name)}`);
      return body.provider === provider.name && modQuotaKnown(body.accounts) ? [provider.name] : [];
    } catch (error) { console.warn("Mode quota unavailable", provider.name, error.message); return []; }
  }));
  // The mod reads Claude's reset from the band's binding limit, under the name 'anthropic'.
  const claude = providers.some((provider) => provider.type === "anthropic") && modQuotaKnown(status && status.claude && status.claude.accounts, true);
  modResetProviders = [...chatgpt.flat(), ...(claude ? ["anthropic"] : [])];
}
/** The name a reset provider goes by: Claude, ChatGPT, or another ChatGPT provider's own name. */
function modResetLabel(provider) {
  return provider === "anthropic" ? "Claude" : provider === "chatgpt" ? "ChatGPT" : provider;
}
/** Choosing reset starts on a known provider the mode's workers use, else the first known one. */
function modResetDefault(rungs) {
  const used = new Set(Object.values(rungs).flatMap((steps) => steps.map((step) => { const choice = modChoiceOf(step.target); return choice && choice.provider; })));
  return modResetProviders.find((provider) => used.has(provider)) || modResetProviders[0];
}
function modUpdateMode(id, change) {
  modPatch({ modes: modState.settings.modes.map((mode) => mode.id === id ? { ...mode, ...change } : mode) });
}
function modSetActive(id) {
  // The start time is when a mode that runs until the quota resets counts its reset from.
  modPatch(id ? { activeMode: id, activeSince: Date.now() } : { activeMode: undefined, activeSince: undefined });
}
function modRemoveMode(mode) {
  if (!confirm(t("mod.modeRemoveConfirm", { name: mode.name }))) return;
  const s = modState.settings;
  modPatch({ modes: s.modes.filter((entry) => entry.id !== mode.id), ...(s.activeMode === mode.id ? { activeMode: undefined, activeSince: undefined } : {}) });
}
function modModeTabs() {
  const s = modState.settings;
  const tabs = [{ id: "", name: t("mod.modeNone") }, ...s.modes];
  if (!tabs.some((tab) => tab.id === modModeTab) && modModeTab !== "+") modModeTab = "";
  const buttons = tabs.map((tab) => {
    const on = (s.activeMode || "") === tab.id;
    return el("button", { type: "button", role: "tab", class: modModeTab === tab.id ? "active" : "", "aria-selected": String(modModeTab === tab.id), "aria-controls": "worker-tab-panel", "data-key": `mode-tab:${tab.id || "base"}`, onclick: () => { modModeTab = tab.id; modRefresh(); } }, [
      el("span", { text: tab.name }), on ? el("span", { class: "mode-on", text: t("mod.modeOn") }) : null,
    ]);
  });
  buttons.push(el("button", { type: "button", role: "tab", "aria-selected": String(modModeTab === "+"), "data-key": "mode-add", text: t("mod.modeAdd"), ...(s.modes.length >= 20 ? { disabled: "" } : {}), onclick: () => { modModeTab = "+"; modRefresh(); } }));
  return el("div", { class: "mode-tabs", role: "tablist", "aria-label": t("mod.modes") }, buttons);
}
function modNewMode() {
  const input = el("input", { type: "text", class: "text-field", maxlength: "40", "data-key": "mode-new-name", "aria-label": t("mod.modeName"), placeholder: t("mod.modeName") });
  const add = () => {
    const name = input.value.trim();
    if (!name) { toast(t("mod.modeNameRequired"), true); input.focus(); return; }
    const mode = { id: `mode-${crypto.randomUUID()}`, name, rungs: clone(modRungs()), ...(modState.settings.domainRules ? { domainRules: clone(modState.settings.domainRules) } : {}), delegation: "normal", until: "none" };
    modModeTab = mode.id;
    modPatch({ modes: [...modState.settings.modes, mode] });
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") add(); });
  return modSection(t("mod.modeAddTitle"), [cell(t("mod.modeName"), [input, el("button", { type: "button", class: "btn compact", text: t("common.save"), "data-key": "mode-create", onclick: add })], t("mod.modeNameHelp"), "wide")]);
}
/** A datetime-local value for an epoch-ms time, in this browser's zone. */
function modLocalTime(ms) {
  const at = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}
function modModeSection(mode) {
  const on = modState.settings.activeMode === mode.id;
  const name = el("input", { type: "text", class: "text-field", value: mode.name, maxlength: "40", "data-key": `mode-name:${mode.id}`, "aria-label": t("mod.modeName") });
  name.addEventListener("change", () => {
    if (!name.value.trim()) { name.value = mode.name; toast(t("mod.modeNameRequired"), true); return; }
    modUpdateMode(mode.id, { name: name.value.trim() });
  });
  const known = modResetProviders.length > 0;
  const kind = typeof mode.until === "number" ? "time" : mode.until && typeof mode.until === "object" ? "reset" : "none";
  const untilOf = (value) => value === "time" ? Date.now() + 3 * 3_600_000 : value === "reset" ? { reset: modResetDefault(mode.rungs) } : value;
  const until = modSegmented("mode-until", [
    { value: "none", label: t("mod.modeUntilNone") }, { value: "time", label: t("mod.modeUntilTime") },
    { value: "reset", label: t("mod.modeUntilResetChoice"), disabled: !known },
  ], kind, t("mod.modeUntil"), (value) => modUpdateMode(mode.id, { until: untilOf(value) }));
  const reset = until.querySelector('[data-key="mode-until:reset"]');
  if (!known) {
    reset.setAttribute("aria-describedby", "mode-reset-reason");
    until.appendChild(el("span", { id: "mode-reset-reason", class: "mode-reset-reason", text: t("mod.modeResetUnknown") }));
  }
  const endControls = [until];
  if (kind === "time") {
    const at = el("input", { type: "datetime-local", class: "text-field", "data-key": "mode-until-time", value: modLocalTime(mode.until), "aria-label": t("mod.modeUntilTime") });
    at.addEventListener("change", () => {
      const ms = new Date(at.value).getTime();
      if (!Number.isFinite(ms) || ms <= Date.now()) { at.value = modLocalTime(mode.until); toast(t("mod.modeTimePast"), true); return; }
      modUpdateMode(mode.id, { until: ms });
    });
    endControls.push(at);
  }
  if (kind === "reset") {
    // Only providers whose reset is known now; a saved one that is not stays shown as unavailable.
    const label = (provider) => t("mod.modeUntilResetOf", { provider: modResetLabel(provider) });
    const items = modResetProviders.map((provider) => ({ value: provider, label: label(provider) }));
    if (!modResetProviders.includes(mode.until.reset)) items.unshift({ value: mode.until.reset, label: `${label(mode.until.reset)}${t("mod.unavailable")}` });
    endControls.push(modSelect("mode-until-reset", items, mode.until.reset, t("mod.modeResetProvider"), (reset) => modUpdateMode(mode.id, { until: { reset } })));
  }
  const endHelp = kind === "reset" ? t("mod.modeResetHelp", { provider: modResetLabel(mode.until.reset) }) : null;
  return modSection(null, [
    cell(t("mod.modeName"), name),
    ...modWorkerRows(mode),
    cell(t("mod.modeDelegation"), modSegmented("mode-delegation", [{ value: "normal", label: t("mod.modeNormal") }, { value: "eager", label: t("mod.modeEager") }], mode.delegation, t("mod.modeDelegation"), (delegation) => modUpdateMode(mode.id, { delegation })), null, "wide"),
    cell(t("mod.modeUntil"), el("div", { class: "mode-until" }, endControls), endHelp, "wide"),
    cell(t("mod.modeActive"), [
      el("button", { type: "button", class: "btn compact", "data-key": "mode-toggle", text: t(on ? "mod.modeTurnOff" : "mod.modeTurnOn"), onclick: () => modSetActive(on ? "" : mode.id) }),
      el("button", { type: "button", class: "btn secondary compact", "data-key": `mode-remove:${mode.id}`, text: t("common.remove"), onclick: () => modRemoveMode(mode) }),
    ], on ? t("mod.modeOn") : null, "wide"),
  ]);
}

function modWorkersCard() {
  const s = modState.settings;
  return modCard("workers", t("mod.workers"), t("mod.workersBlurb"), [
    modState.options ? null : modSection(null, [el("div", { class: "cell-note warn-text", text: t("mod.optionsFailed") })]),
    modState.retiredNote ? modRetiredNote() : null,
    modSection(null, [
      cell(t("mod.takesOver"), modSegmented("agent-auto", [{ value: "off", label: t("mod.off") }, { value: "auto", label: "ripple:auto" }, { value: "all", label: t("mod.allSpawns") }], s.agentAuto, t("mod.takesOver"), (agentAuto) => modPatch({ agentAuto })), null, "wide"),
    ], [t("mod.takesOverHelp"), t("mod.takesOverHelp2")]),
    modModeTabs(),
    el("div", { id: "worker-tab-panel", role: "tabpanel" }, modModeTab === "+" ? [modNewMode()] : modModeTab ? [modModeSection(s.modes.find((mode) => mode.id === modModeTab))] : [
      modSection(t("mod.models"), modTickRows(), [t("mod.modelsHelp")]),
      modSection(t("mod.fourWorkers"), modWorkerRows(), [t("mod.modeOrderHelp")]),
      modSection(null, [
        cell(t("mod.modeDelegation"), modSegmented("base-delegation", [{ value: "normal", label: t("mod.modeNormal") }, { value: "eager", label: t("mod.modeEager") }], s.delegation || "normal", t("mod.modeDelegation"), (delegation) => modPatch({ delegation })), t("mod.baseDelegationHelp"), "wide"),
      ]),
      s.activeMode ? modSection(null, [cell(t("mod.modeActive"), el("button", { type: "button", class: "btn secondary compact", "data-key": "mode-base-on", text: t("mod.modeUseBase"), onclick: () => modSetActive("") }))]) : null,
    ].filter(Boolean)),
  ]);
}

function modJudgeCard() {
  const s = modState.settings;
  const zen = modState.options && modState.options.zen;
  const rows = [cell(t("mod.judge"), modSegmented("judge", [{ value: "haiku", label: t("mod.haiku") }, { value: "jev", label: t("mod.jev") }, { value: "model", label: t("mod.routerModel") }], s.judge, t("mod.judge"), (judge) => modPatch({ judge })), null, "wide")];
  const footers = [];
  if (s.judge === "haiku") rows.push(el("div", { class: "cell-note", text: t("mod.haikuHint") }));
  if (s.judge === "jev") {
    rows.push(cell(t("mod.jevSource"), modSegmented("jev-source", [{ value: "typesafe", label: t("mod.typesafe") }, { value: "zen", label: t("mod.zen") }], s.jevSource, t("mod.jevSource"), (jevSource) => modPatch({ jevSource })), null, "wide"));
    if (s.jevSource === "zen") {
      rows.push(zen && zen.configured
        ? cell(t("mod.model"), el("span", { class: "mono", text: zen.model }), modCap(t("mod.zenKey")))
        : cell(el("span", { class: "cell-label", text: modCap(t("mod.zenMissing")) }), el("button", { class: "btn secondary compact", type: "button", text: t("nav.providers"), onclick: () => showView("providers") }), t("mod.zenAdd")));
    } else {
      rows.push(el("div", { class: "cell-note", text: t("mod.jevKeyNote") }));
    }
  }
  if (s.judge === "model") {
    const models = modModels().map((model) => ({ value: model.model, label: `${model.name || model.model} · ${model.provider}` }));
    rows.push(cell(t("mod.model"), models.length || s.judgeModel
      ? modSelect("judge-model", models, s.judgeModel, t("mod.model"), (judgeModel) => modPatch({ judgeModel }))
      : el("span", { text: modCap(t("mod.noModels")) }), modCap(t("mod.haikuFallback"))));
  }
  return modCard("judge", t("mod.judge"), t("mod.judgeBlurb"), [modSection(null, rows, footers)]);
}

function modCacheCard() {
  const s = modState.settings;
  return modCard("cache", t("mod.cache"), t("mod.cacheBlurb"), [modSection(null, [
    cell(t("mod.keepWarm"), modSwitch("keep-warm", s.keepWarm, t("mod.keepWarm"), (keepWarm) => modPatch({ keepWarm })), modCap(t("mod.keepWarmHint"))),
    cell(t("mod.for"), modSegmented("warm-hours", [1, 2, 4, 8].map((n) => ({ value: n, label: t("mod.hours", { n }) })), s.keepWarmHours, t("mod.for"), (n) => modPatch({ keepWarmHours: Number(n) })), modCap(t("mod.afterReply")), "wide"),
    cell(t("mod.chatsFrom"), modSegmented("warm-min", [10000, 30000, 60000, 100000].map((n) => ({ value: n, label: `${n / 1000}k` })), s.keepWarmMinTokens, t("mod.chatsFrom"), (n) => modPatch({ keepWarmMinTokens: Number(n) })), modCap(t("mod.tokens")), "wide"),
  ], [t("mod.warmCost")])]);
}

function modHandoffCard() {
  const s = modState.settings;
  const skill = el("input", { type: "text", class: "text-field", value: s.handoffSkill, placeholder: t("mod.noSkill"), spellcheck: "false", autocomplete: "off", "data-key": "handoff-skill", "aria-label": t("mod.fullHandoff") });
  skill.addEventListener("change", () => modPatch({ handoffSkill: skill.value.trim() }));
  return modCard("handoff", t("mod.handoff"), t("mod.handoffBlurb"), [modSection(null, [
    cell(t("mod.compactWith"), modSegmented("compact-with", [{ value: "haiku", label: t("mod.haiku") }, { value: "session", label: t("mod.sessionCompactor") }], s.compactWith, t("mod.compactWith"), (compactWith) => modPatch({ compactWith })), null, "wide"),
    cell(t("mod.afterHandoff"), modSegmented("handoff-after", [{ value: "continue", label: t("mod.continue") }, { value: "confirm", label: t("mod.confirm") }, { value: "copy", label: t("mod.copy") }], s.handoffAfter, t("mod.afterHandoff"), (handoffAfter) => modPatch({ handoffAfter })), null, "wide"),
    cell(t("mod.handoffButton"), modSegmented("handoff-button", [{ value: "advised", label: t("mod.whenAdvised") }, { value: "always", label: t("mod.always") }], s.handoffButton, t("mod.handoffButton"), (handoffButton) => modPatch({ handoffButton })), null, "wide"),
    cell(t("mod.fullHandoff"), skill, null, "wide"),
    cell(t("mod.heavyAt"), modSegmented("swamp-at", [40, 50, 60, 70].map((n) => ({ value: n, label: `${n}%` })), s.swampAt, t("mod.heavyAt"), (n) => modPatch({ swampAt: Number(n) })), modCap(t("mod.context")), "wide"),
  ])]);
}

function modLookCard() {
  const s = modState.settings;
  const languages = [{ value: "auto", label: t("mod.auto") }, ...MOD_LANGUAGES.map(([value, label]) => ({ value, label }))];
  return modCard("look", t("mod.look"), t("mod.lookBlurb"), [
    modSection(null, [
      cell(t("mod.layout"), modSegmented("layout", [{ value: "dashboard", label: t("mod.dashboard") }, { value: "minimal", label: t("mod.minimal") }], s.layout, t("mod.layout"), (layout) => modPatch({ layout })), s.layout === "minimal" ? modCap(t("mod.footerHint")) : null, "wide"),
      cell(t("mod.appearance"), modSegmented("appearance", [{ value: "auto", label: t("mod.auto") }, { value: "dark", label: t("mod.dark") }, { value: "light", label: t("mod.lightAppearance") }], s.appearance, t("mod.appearance"), (appearance) => modPatch({ appearance })), null, "wide"),
      cell(t("mod.skin"), modSegmented("skin", [{ value: "deep", label: t("mod.skinDeep") }, { value: "flat", label: t("mod.skinFlat") }], s.skin || "deep", t("mod.skin"), (skin) => modPatch({ skin })), null, "wide"),
      cell(t("mod.language"), modSelect("language", languages, s.language, t("mod.language"), (language) => modPatch({ language }), "narrow")),
    ]),
    modSection(t("mod.show"), [
      ...MOD_PARTS.map((part) => {
        const shown = !s.hide.includes(part);
        return cell(t(`mod.part.${part}`), modSwitch(`part:${part}`, shown, t(`mod.part.${part}`), (on) => modPatch({ hide: on ? s.hide.filter((entry) => entry !== part) : [...s.hide, part] })));
      }),
      ...MOD_EXTRAS.map((part) => {
        const extras = s.extras || [];
        const shown = extras.includes(part);
        return cell(t(`mod.part.${part}`), modSwitch(`part:${part}`, shown, t(`mod.part.${part}`), (on) => modPatch({ extras: on ? [...extras, part] : extras.filter((entry) => entry !== part) })));
      }),
    ]),
  ]);
}

// ---- Logs ---------------------------------------------------------------------------

let logsPanel = "requests";
let requestRows = [];
let knownRequestProviders = new Set();
let requestProvider = "";
let showCountTokens = false;
let expandedRequestId = null;
// The usage period. "hour" is the exact rolling hour; every other period reads the hourly history.
const USAGE_PERIODS = ["hour", "today", "7d", "30d", "month", "all", "custom"];
const USAGE_STORE = "clauderipple_logs_usage";
let usagePeriod = "hour";
let usageFrom = ""; // custom start, a local "YYYY-MM-DD"
let usageTo = ""; // custom end (inclusive), a local "YYYY-MM-DD"
let lastSummary = null;
let configuredProviders = null; // provider names from /api/config, fetched once for this view
let renderedProviderNames = "";
let requestsGeneration = 0;
(function restoreUsage() {
  try {
    const saved = JSON.parse(localStorage.getItem(USAGE_STORE) || "null");
    if (!saved || typeof saved !== "object") return;
    if (USAGE_PERIODS.includes(saved.period)) usagePeriod = saved.period;
    if (isDay(saved.from)) usageFrom = saved.from;
    if (isDay(saved.to)) usageTo = saved.to;
    if (typeof saved.provider === "string") requestProvider = saved.provider;
  } catch { /* storage unavailable or unreadable: start from the defaults */ }
})();
function saveUsage() {
  try { localStorage.setItem(USAGE_STORE, JSON.stringify({ period: usagePeriod, from: usageFrom, to: usageTo, provider: requestProvider })); } catch { /* unavailable */ }
}

function colorizeLogLine(line) {
  const cls = /\bERROR\b|\berror\b/.test(line) ? "tag-ERR" : /\bWARN\b/.test(line) ? "tag-WARN" : "tag-PASS";
  return el("div", { class: cls, text: line });
}
function formatNumber(value) { return typeof value === "number" ? value.toLocaleString() : t("common.notAvailable"); }
function formatSeconds(ms) { return t("logs.seconds", { value: (Math.max(0, ms || 0) / 1000).toFixed(ms >= 10_000 ? 1 : 2) }); }
function timeOf(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.valueOf())) return t("common.notAvailable");
  const two = (n) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}
function providerClass(name) { return name === "anthropic" ? "provider-anthropic" : name === "chatgpt" ? "provider-chatgpt" : "provider-default"; }
function summaryChip(label, value, sub) { return el("div", { class: "logs-chip" }, [el("span", { class: "label", text: label }), el("span", { class: "value", text: value }), sub ? el("span", { class: "sub", text: sub }) : null]); }

function showLogsPanel(name) {
  logsPanel = name;
  const requests = name === "requests";
  $("#logs-requests-tab").classList.toggle("active", requests);
  $("#logs-raw-tab").classList.toggle("active", !requests);
  $("#logs-requests-tab").setAttribute("aria-selected", String(requests));
  $("#logs-raw-tab").setAttribute("aria-selected", String(!requests));
  $("#logs-requests-panel").hidden = !requests;
  $("#logs-raw-panel").hidden = requests;
  if (requests) void refreshRequests();
  else void refreshLogs();
}
$("#logs-requests-tab").addEventListener("click", () => showLogsPanel("requests"));
$("#logs-raw-tab").addEventListener("click", () => showLogsPanel("raw"));
$("#logs-provider").addEventListener("change", (event) => { requestProvider = event.target.value; saveUsage(); void refreshRequests(); });

// ---- Usage period: local calendar days, so "today" starts at this machine's midnight.
function isDay(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayStart(value).valueOf()); }
function dayStart(value) { const [y, m, d] = value.split("-").map(Number); return new Date(y, m - 1, d); }
function dayKey(date) { const two = (n) => String(n).padStart(2, "0"); return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`; }
function daysAgo(n) { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n); }
/** The period as `{from, to}` in epoch ms (`to` exclusive), or null for the rolling hour. */
function usageRange() {
  const now = Date.now();
  if (usagePeriod === "today") return { from: daysAgo(0).valueOf(), to: now };
  if (usagePeriod === "7d") return { from: daysAgo(6).valueOf(), to: now };
  if (usagePeriod === "30d") return { from: daysAgo(29).valueOf(), to: now };
  if (usagePeriod === "month") { const today = new Date(); return { from: new Date(today.getFullYear(), today.getMonth(), 1).valueOf(), to: now }; }
  if (usagePeriod === "all") return { from: 0, to: now };
  if (usagePeriod === "custom") {
    if (!isDay(usageFrom) || !isDay(usageTo)) return null;
    const [first, last] = usageFrom <= usageTo ? [usageFrom, usageTo] : [usageTo, usageFrom];
    const end = dayStart(last);
    return { from: dayStart(first).valueOf(), to: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).valueOf() };
  }
  return null;
}
function formatDay(ms, withYear) {
  const options = withYear ? { year: "numeric", month: "short", day: "numeric" } : { month: "short", day: "numeric" };
  try { return new Intl.DateTimeFormat(CURRENT_LANG, options).format(new Date(ms)); } catch { return dayKey(new Date(ms)); }
}
/** What the usage numbers cover, in words: "Last hour · …" or "Oct 14 – Oct 20 · Records start Oct 12". */
function usageCaption(range, earliest) {
  if (!range) return `${t("logs.lastHour")} · ${t("logs.polling")}`;
  const firstRecord = earliest ? new Date(earliest).valueOf() : NaN;
  // "All" starts where the records do; any other period that starts before them says so.
  const start = usagePeriod === "all" && Number.isFinite(firstRecord) ? firstRecord : range.from;
  const end = Math.max(start, Math.min(range.to, Date.now()) - 1);
  const year = new Date().getFullYear();
  const withYear = new Date(start).getFullYear() !== year || new Date(end).getFullYear() !== year;
  const first = formatDay(start, withYear);
  const last = formatDay(end, withYear);
  const parts = [first === last ? first : `${first} – ${last}`];
  if (usagePeriod !== "all" && Number.isFinite(firstRecord) && firstRecord > range.from) parts.push(t("logs.since", { date: formatDay(firstRecord, withYear) }));
  return parts.join(" · ");
}
function renderPeriodControl() {
  const control = $("#logs-period");
  control.replaceChildren(...USAGE_PERIODS.map((period) => {
    const on = period === usagePeriod;
    return el("button", { type: "button", class: on ? "active" : "", role: "radio", "aria-checked": String(on), text: t(`logs.period.${period}`), onclick: () => pickPeriod(period) });
  }));
  $("#logs-custom").hidden = usagePeriod !== "custom";
}
function pickPeriod(period) {
  if (period === usagePeriod) return;
  usagePeriod = period;
  if (period === "custom") {
    // A first custom range starts as the last seven days, so both fields hold something to adjust.
    if (!isDay(usageFrom)) usageFrom = dayKey(daysAgo(6));
    if (!isDay(usageTo)) usageTo = dayKey(daysAgo(0));
    fillCustomDates();
  }
  saveUsage();
  renderPeriodControl();
  void refreshRequests();
}
// Written only on load and when the period becomes custom: the 3-second refresh never touches these
// fields, so a date being typed is not reset under the cursor.
function fillCustomDates() {
  const today = dayKey(daysAgo(0));
  for (const [selector, value] of [["#logs-from", usageFrom], ["#logs-to", usageTo]]) {
    const input = $(selector);
    input.value = value;
    input.max = today;
  }
}
for (const selector of ["#logs-from", "#logs-to"]) {
  $(selector).addEventListener("change", () => {
    const from = $("#logs-from").value;
    const to = $("#logs-to").value;
    if (!isDay(from) || !isDay(to)) return;
    usageFrom = from;
    usageTo = to;
    saveUsage();
    void refreshRequests();
  });
}
renderPeriodControl();
fillCustomDates();

const EMPTY_BUCKET = { count: 0, ok: 0, failed: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, avgMs: 0, cacheHitPercent: 0 };
function renderSummary(summary) {
  const providers = (summary && summary.providers) || {};
  const total = (requestProvider ? providers[requestProvider] : summary && summary.total) || EMPTY_BUCKET;
  $("#logs-summary").replaceChildren(
    summaryChip(t("logs.summary.requests"), formatNumber(total.count)),
    summaryChip(t("logs.summary.success"), `${formatNumber(total.ok)} / ${formatNumber(total.failed)}`),
    // On its own line: with the whole input counted the number runs to eight digits, and the
    // ellipsis on one line cut the cache rate off entirely.
    summaryChip(t("logs.summary.input"), formatNumber(totalInputOf(total)), t("logs.cacheHit", { percent: total.cacheHitPercent || 0 })),
    summaryChip(t("logs.summary.output"), formatNumber(total.output)),
    summaryChip(t("logs.summary.duration"), formatSeconds(total.avgMs)),
  );
  fitSummaryValues();
}
// A long period runs the input to ten digits and the requests to "52,939 / 310", wider than a chip
// in a 1,024px window (2026-10-20): a value that overflows steps its type down before it ellipsizes.
function fitSummaryValues() {
  for (const value of document.querySelectorAll("#logs-summary .logs-chip .value")) {
    value.style.fontSize = "";
    for (let size = parseFloat(getComputedStyle(value).fontSize); value.scrollWidth > value.clientWidth && size > 14; size--) value.style.fontSize = `${size - 1}px`;
    // A pane about 300px wide fits no ten digits even then: a plain number goes compact ("78.9억"),
    // the whole of it on hover. The next refresh draws it whole again.
    const whole = value.dataset.whole || value.textContent;
    const number = Number(whole.replace(/,/g, ""));
    if (value.scrollWidth > value.clientWidth && whole.includes(",") && Number.isFinite(number)) {
      value.dataset.whole = whole;
      value.title = whole;
      value.textContent = new Intl.NumberFormat(CURRENT_LANG, { notation: "compact", maximumFractionDigits: 1 }).format(number);
    }
  }
}
window.addEventListener("resize", fitSummaryValues);
// Every provider that is configured or shows up in the usage or the requests, not only the ones in
// the last 200 requests: those were all one provider for a heavy user, so the menu offered nothing
// else (2026-10-20). The chosen provider stays listed even before anything names it.
function renderProviderFilter(summary, records) {
  const configured = (currentConfig && currentConfig.providers) || configuredProviders || (status && status.providers) || {};
  for (const name of Object.keys(configured)) knownRequestProviders.add(name);
  for (const name of Object.keys((summary && summary.providers) || {})) knownRequestProviders.add(name);
  for (const model of (summary && Array.isArray(summary.models) ? summary.models : [])) if (model.provider) knownRequestProviders.add(model.provider);
  for (const record of records) if (record.provider) knownRequestProviders.add(record.provider);
  if (requestProvider) knownRequestProviders.add(requestProvider);
  const names = [...knownRequestProviders].sort();
  // Rebuilt only when the list changes, so the 3-second refresh does not close an open menu.
  const key = names.join("\n");
  const select = $("#logs-provider");
  if (key !== renderedProviderNames) {
    renderedProviderNames = key;
    select.replaceChildren(el("option", { value: "", text: t("logs.all") }), ...names.map((name) => el("option", { value: name, text: name })));
  }
  if (select.value !== requestProvider) select.value = requestProvider;
}
async function loadConfiguredProviders() {
  if (configuredProviders || currentConfig) return;
  try { configuredProviders = (await api("/api/config")).providers || {}; } catch { /* the usage and requests still name their providers */ }
}
function modelUsageRow(entry) {
  const total = totalInputOf(entry);
  const model = el("div", { class: "request-models" }, [
    el("span", { class: "model", text: entry.model, title: entry.model }),
    el("span", { class: `provider-badge ${providerClass(entry.provider)}`, text: entry.provider }),
  ]);
  // The labels show only where a narrow window drops the header row.
  return el("tr", {}, [
    el("td", { class: "c-model" }, [model]),
    el("td", { class: "c-count", "data-label": t("logs.th.count") }, [formatNumber(entry.count)]),
    el("td", { class: "c-in", "data-label": t("logs.th.input") }, [el("span", { class: "token-cell", text: formatNumber(total) }, [el("span", { class: "cache-pill", text: t("logs.cacheHit", { percent: entry.cacheHitPercent || 0 }) })])]),
    el("td", { class: "c-out", "data-label": t("logs.th.output") }, [formatNumber(entry.output)]),
    el("td", { class: "c-dur", "data-label": t("logs.th.avg") }, [formatSeconds(entry.avgMs)]),
  ]);
}
function renderModelUsage(summary) {
  const models = (summary && Array.isArray(summary.models) ? summary.models : []).filter((entry) => !requestProvider || entry.provider === requestProvider);
  $("#models-table tbody").replaceChildren(...models.map(modelUsageRow));
  $("#models-table").closest(".logs-table-card").hidden = models.length === 0;
  $("#models-empty").hidden = models.length !== 0;
}
/** Everything the model read: uncached, read from the cache, and written to it. */
function totalInputOf(usage) {
  return (usage.input || 0) + (usage.cached || 0) + (usage.cacheWrite || 0);
}
function requestDetail(record) {
  const details = [
    [t("logs.detail.id"), record.id],
    [t("logs.detail.kind"), record.kind],
    [t("logs.detail.stop"), record.stopReason || t("logs.none")],
    [t("logs.detail.uncached"), record.usage ? formatNumber(record.usage.input) : t("logs.none")],
    [t("logs.detail.cacheRead"), record.usage && record.usage.cached ? formatNumber(record.usage.cached) : t("logs.none")],
    [t("logs.detail.cacheWrite"), record.usage && record.usage.cacheWrite ? formatNumber(record.usage.cacheWrite) : t("logs.none")],
  ].map(([label, value]) => el("div", {}, [el("span", { class: "detail-label", text: label }), el("span", { class: "detail-value", text: value })]));
  if (record.note) details.push(el("div", { class: "request-note" }, [el("span", { class: "detail-label", text: t("logs.detail.note") }), el("span", { class: "detail-value", text: record.note })]));
  return el("tr", { class: "request-detail" }, [el("td", { colspan: "7" }, [el("div", { class: "request-detail-grid" }, details)])]);
}
function requestRow(record) {
  const row = el("tr", { class: "request-row", title: record.note || "", onclick: () => { expandedRequestId = expandedRequestId === record.id ? null : record.id; renderRequests(requestRows); } });
  // The requested name's `@effort` is the agent file's default, not what was sent: a marker can
  // override it, and `gpt-6-sol@medium` beside an effort of high read as a contradiction
  // (2026-09-23). The effort column is the sent value, so the source is shown without it.
  const source = record.source ? record.source.replace(/@[^@]*$/, "") : "";
  const model = el("div", { class: "request-models" }, [
    el("span", { class: "model", text: record.target }),
    source && source !== record.target ? el("span", { class: "small", text: `(${source})` }) : null,
    el("span", { class: `provider-badge ${providerClass(record.provider)}`, text: record.provider }),
  ].filter(Boolean));
  // The whole input, not the uncached remainder: a fully cached Anthropic turn reports `input: 2`,
  // which read as a two-token request (2026-09-23). The split is in the detail row.
  const totalInput = record.usage ? totalInputOf(record.usage) : 0;
  const input = record.usage
    ? el("span", { class: "token-cell", text: formatNumber(totalInput) }, [el("span", { class: "cache-pill", text: t("logs.cacheHit", { percent: Math.round(record.usage.cached / Math.max(1, totalInput) * 100) }) })])
    : el("span", { class: "no-usage", text: t("common.notAvailable") });
  const status = record.resent
    ? el("span", { class: "status-text resent", text: `${t("logs.status.resent")} ${record.status}`, title: t("logs.status.resentHelp") })
    : el("span", { class: `status-text ${record.ok ? "ok" : "bad"}`, text: `${record.ok ? t("logs.status.ok") : t("logs.status.error")} ${record.status}` });
  // Column classes let a narrow window lay the same row out as a two-line list item.
  row.append(
    el("td", { class: "c-time", text: timeOf(record.at) }),
    el("td", { class: "c-model" }, [model]),
    el("td", { class: "c-effort", text: record.effort || t("common.notAvailable") }),
    el("td", { class: "c-in" }, [input]),
    el("td", { class: record.usage ? "c-out" : "c-out no-usage", text: record.usage ? formatNumber(record.usage.output) : t("common.notAvailable") }),
    el("td", { class: "c-dur", text: formatSeconds(record.ms) }),
    el("td", { class: "c-status" }, [status]),
  );
  return row;
}
function renderRequests(records) {
  const scroll = $("#requests-table").closest(".logs-table-card");
  const left = scroll.scrollLeft;
  const tbody = $("#requests-table tbody");
  tbody.replaceChildren(...records.flatMap((record) => expandedRequestId === record.id ? [requestRow(record), requestDetail(record)] : [requestRow(record)]));
  scroll.hidden = records.length === 0;
  $("#requests-empty").hidden = records.length !== 0;
  scroll.scrollLeft = left;
}
async function refreshRequests() {
  if (logsPanel !== "requests") return;
  // A period or provider picked while an older refresh is in flight must not be painted over by it.
  const generation = ++requestsGeneration;
  const provider = requestProvider;
  const range = usageRange();
  // A custom range with an unusable date waits for the fields instead of falling back to the hour.
  if (usagePeriod === "custom" && !range) return;
  $("#logs-range-caption").textContent = usageCaption(range, lastSummary && lastSummary.earliest);
  const summaryPath = range ? `/api/requests/summary?from=${range.from}&to=${range.to}` : "/api/requests/summary?since=3600";
  const suffix = provider ? `&provider=${encodeURIComponent(provider)}` : "";
  const [records, summary] = await Promise.allSettled([api(`/api/requests?n=200${suffix}&kind=messages,image`), api(summaryPath), loadConfiguredProviders()]);
  if (generation !== requestsGeneration) return;
  // Each half keeps its last good contents when its own call fails.
  if (summary.status === "fulfilled") {
    lastSummary = summary.value;
    $("#logs-range-caption").textContent = usageCaption(range, lastSummary.earliest);
    renderSummary(lastSummary);
    renderModelUsage(lastSummary);
  }
  if (records.status === "fulfilled") {
    requestRows = Array.isArray(records.value.requests) ? records.value.requests : [];
    renderRequests(requestRows);
  }
  renderProviderFilter(lastSummary, requestRows);
}
async function refreshLogs() {
  if (logsPanel !== "raw") return;
  const box = $("#logbox");
  try {
    const response = await fetch("/api/logs?n=200");
    const text = await response.text();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.replaceChildren(...text.split("\n").filter(Boolean).map(colorizeLogLine));
    if ($("#logs-autoscroll").checked || nearBottom) box.scrollTop = box.scrollHeight;
  } catch { /* preserve the last contents */ }
}
void refreshRequests();
setInterval(() => { void refreshRequests(); void refreshLogs(); }, 3000);
