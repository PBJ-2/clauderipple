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

// Baselines are indexed by the revision carried through JSON clones used by save handlers.
const configSnapshots = new Map();
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
  if (path === "/api/config" && (!opts || !opts.method || opts.method === "GET") && body.configRevision !== undefined) {
    configSnapshots.set(body.configRevision, clone(body));
    if (configSnapshots.size > 32) configSnapshots.delete(configSnapshots.keys().next().value);
  }
  return body;
}

// The router writes `cli.models` to settings.json on this save (they only take effect there). If
// that write could not happen it says so here — a slot that silently does nothing is the bug this
// call used to be, so a failure must reach the screen rather than the router log.
/**
 * @param {Object} next
 * @param {(fresh: Object, replay: () => Object) => Object} [rebase] Reapply an editor's atomic changes
 *   on a conflict; `replay` is the default merge of this save's field changes onto `fresh`.
 */
async function configRequest(next, rebase) {
  // Older routers return a raw config without a revision: keep their existing PUT contract.
  const base = configSnapshots.get(next.configRevision);
  const arrayKeys = { models: "id", extraModels: "model", direct: "prefix", credentials: "id" };
  const changes = base ? modChanges(base, next, [], arrayKeys).filter((change) => change.path[0] !== "configRevision") : null;
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      if (out && out.configRevision !== undefined) next.configRevision = out.configRevision;
      return out;
    } catch (error) {
      if (error.status !== 409 || (!changes && !rebase) || attempt >= 3) throw error;
      const fresh = await api("/api/config");
      const replay = () => changes ? modApply(fresh, changes, arrayKeys) : clone(fresh);
      const rebased = rebase ? rebase(fresh, replay) : replay();
      // Callers retain `next` as their saved copy, including everything the retry preserved.
      for (const key of Object.keys(next)) delete next[key];
      Object.assign(next, rebased);
    }
  }
}

/** Report one save outcome, never a success toast over a partial-success warning.
 * @param {{warning?: string} | undefined} out
 * @param {string} [message] Success text; omitted by editors with an inline saved status.
 * @param {string} [warning] An additional caller warning, shown alongside the server's warning.
 */
function configSaved(out, message, warning) {
  const warnings = [out && out.warning, warning].filter(Boolean);
  if (warnings.length) toast(warnings.join("\n"), true);
  else if (message) toast(message);
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
// A provider's key is a slug that never changes once saved (routes, mappings and the picker name
// it), so the name the user typed lives in `label`. Show `label || key` wherever a person reads it.
function providerLabel(name, provider = currentConfig && currentConfig.providers && currentConfig.providers[name]) {
  return (provider && typeof provider.label === "string" && provider.label.trim()) || name;
}
/**
 * A provider's name where a person scans a list of them (the Status screen): the name the user typed,
 * else its preset's name ("OpenCode Go", without a "(local)" aside), else the service its type is
 * ("Claude", "ChatGPT", "Gemini"), else a placeholder key ("provider") gives way to its host. The key
 * itself is the last resort: it is a slug the user may never have chosen.
 */
const PROVIDER_TYPE_TITLES = { anthropic: "Claude", chatgpt: "ChatGPT", google: "Gemini", grok: "Grok" };
function providerTitle(name, provider) {
  const label = provider && typeof provider.label === "string" && provider.label.trim();
  if (label) return label;
  const preset = provider && provider.preset && presetById(provider.preset);
  if (preset && preset.name) return preset.name.replace(/\s*\([^)]*\)\s*$/, "");
  if (provider && PROVIDER_TYPE_TITLES[provider.type]) return PROVIDER_TYPE_TITLES[provider.type];
  if (/^provider(?:-\d+)?$/.test(name) && provider && provider.url) {
    try { return new URL(provider.url).hostname.replace(/^(?:api[\w-]*|www)\./, ""); } catch { /* not a URL: the key stays */ }
  }
  return name;
}
/**
 * The vendor's hue for a provider's dot, as the mod's band colours them (packages/mod/hooks/ui/theme.ts
 * providerColor): a known vendor keeps its own, any other a fixed pick from a palette with no status
 * red, green or amber in it, so a dot is never read as a result.
 */
const PROVIDER_HUES = { anthropic: "#d97757", chatgpt: "#10a37f", google: "#4285f4", deepseek: "#4d6bfe", "opencode-go": "#9333ea", "opencode-zen": "#9333ea", minimax: "#e5484d", grok: "#a8a29e", "xai-grok": "#a8a29e" };
const PROVIDER_PALETTE = ["#0891b2", "#db2777", "#7c3aed", "#0d9488", "#c026d3", "#4f46e5", "#0284c7", "#be185d"];
function providerHue(name, provider) {
  const known = PROVIDER_HUES[name] || (provider && (PROVIDER_HUES[provider.preset] || PROVIDER_HUES[provider.type]));
  if (known) return known;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROVIDER_PALETTE[hash % PROVIDER_PALETTE.length];
}
// The typed name is kept only when it says something the key does not; typing the key back clears it.
function applyProviderLabel(provider, key, typedName) {
  const label = typedName.trim().slice(0, 60);
  if (label && label !== key) provider.label = label;
  else delete provider.label;
  return provider;
}
/**
 * A provider's name on the Providers, Model mapping and Clients pages: the name people know it by
 * (providerTitle), with its key after it only when another provider would read the same ("ChatGPT
 * (chatgpt-2)"), so two of a kind stay apart in a list or a menu.
 */
function providerName(name, provider = currentConfig && currentConfig.providers && currentConfig.providers[name]) {
  const title = providerTitle(name, provider);
  const others = Object.entries((currentConfig && currentConfig.providers) || {}).filter(([key]) => key !== name);
  return title !== name && others.some(([key, other]) => providerTitle(key, other) === title) ? `${title} (${name})` : title;
}
/** The vendor's hue as a dot before a provider's name, as on the Status screen. */
function vendorDot(name, provider) {
  const dot = el("span", { class: "vendor-dot", "aria-hidden": "true" });
  dot.style.color = providerHue(name, provider);
  return dot;
}
// The router's `isTargetProvider` (packages/router/src/targets.ts), copied because the forms ask it of
// providers not saved yet; `ui-targets.test.ts` keeps the two equal. A native Claude login becomes a
// mapping target only after the explicit account-pool opt-in, and stays OpenAI-ingress-only without
// it. An API key is a target, reached only by name: its `<model>-<provider>` workers, a slot or a rule.
function isTargetProvider(provider) {
  if (!provider) return false;
  if (provider.type !== "anthropic") return true;
  return provider.auth === "api-key" ? provider.accountPool !== true : provider.accountPool === true && provider.auth === "claude-code";
}
function groupedModels(config) {
  const groups = [];
  for (const [name, provider] of Object.entries(config.providers || {})) {
    // A Claude API key serves its `<model>-<provider>` workers only: a bare Claude id picked here
    // would run on the app's own sign-in instead (targets.ts `bareOwners`).
    if (!isTargetProvider(provider) || (provider.type === "anthropic" && provider.auth === "api-key")) continue;
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
// Routed models do not share a context window. `windows` is the value the router resolved for each
// model (a saved override included) and `catalogWindows` is the live Codex catalogue's own figure,
// which the window editor prefills and annotates while no override is in effect.
let pickerContextWindows = { windows: {}, catalogWindows: {} };
function discoveredContextWindow(providerName, modelId) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[providerName];
  const entry = provider && modelsOf(provider).find((item) => item.id === modelId);
  return entry && Number.isFinite(entry.contextWindow) ? entry.contextWindow : undefined;
}
function savedContextWindow(modelId) {
  const entry = ((currentConfig && currentConfig.cli && currentConfig.cli.extraModels) || []).find((item) => item.model === modelId);
  return entry && Number.isFinite(entry.contextWindow) ? entry.contextWindow : undefined;
}
// A model whose window neither its provider nor the live Codex catalogue states runs on the global
// fallback (`cli.autoCompactWindow`) — a number nobody measured for it. Saying so on the model's own
// row is the only place it shows: Hive's `/models` lists ids and nothing else, and a silent fallback
// is what made a 1M model compact at a quarter of its window.
function modelWindowNote(model) {
  if (Number.isFinite(model.contextWindow)) return null;
  if (Number.isFinite(pickerContextWindows.catalogWindows[model.id])) return null;
  const fallback = currentConfig && currentConfig.cli ? currentConfig.cli.autoCompactWindow : undefined;
  return Number.isFinite(fallback)
    ? t("providers.windowUnknown", { fallback: formatNumber(fallback) })
    : t("providers.windowUnknownNoFallback");
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
  for (const button of $all(".nav-btn")) {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    // The style showed the current page; a screen reader was told nothing (G-D10).
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    // On a phone the tab bar scrolls sideways (style.css, under 560px): the open page's tab is brought into it.
    const list = button.parentElement;
    if (active && list && list.scrollWidth > list.clientWidth) {
      const offset = button.getBoundingClientRect().left - list.getBoundingClientRect().left;
      list.scrollLeft += offset - (list.clientWidth - button.offsetWidth) / 2;
    }
  }
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

let limitsSnapshot = null;
// Set when a read fails after a snapshot exists: its figures stay on screen, marked stale.
let limitsSnapshotStale = false;
// The read in flight, so a poll never starts another behind a slow provider.
let limitsRead = null;
// The mod's EXHAUST_URGENT_MS: an exhaust forecast this close is red.
const LIMITS_EXHAUST_URGENT_MS = 60 * 60_000;

/** The time left as the mod's limits pane writes it ("2h 10m", "2d 5h", "45m"), in the same units. */
function limitsTimeLeft(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? t("units.dayHour", { d: days, h: hours }) : t("units.days", { n: days });
  if (hours > 0) return rest > 0 ? t("units.hourMin", { h: hours, m: rest }) : t("units.hours", { n: hours });
  return t("units.minutes", { n: rest });
}

/** Milliseconds until a window runs out at its pace, or null: no forecast, or that moment has passed. */
function limitsExhaustLeft(window, now) {
  if (!window || !Number.isFinite(window.exhaustAt) || window.exhaustAt <= now) return null;
  return window.exhaustAt - now;
}

/**
 * The mod's paceLevel: a window with no exhaust forecast says where its pace takes it at the reset,
 * comfortable under 95% and tight from 95 to 100. Nothing when an exhaust forecast applies, the reset is
 * missing or has passed, there is no projection, or the projection is above 100.
 */
function limitsPaceLevel(window, now) {
  if (!window || limitsExhaustLeft(window, now) !== null) return null;
  if (!Number.isFinite(window.resetAt) || window.resetAt <= now) return null;
  if (!Number.isFinite(window.projectedPercent)) return null;
  if (window.projectedPercent < 95) return "comfortable";
  return window.projectedPercent <= 100 ? "tight" : null;
}

/** The mod's limitItemTone for an exhaust note: the share's tone, at least amber, red within the hour. */
function limitsNoteTone(window, exhaustLeft) {
  const share = window.usedPercent >= 95 ? "bad" : window.usedPercent >= 80 ? "warn" : "ink";
  if (exhaustLeft === null || share === "bad") return share;
  return exhaustLeft <= LIMITS_EXHAUST_URGENT_MS ? "bad" : "warn";
}

function limitsReset(window, weekly, now) {
  if (!window || !Number.isFinite(window.resetAt)) return t("limits.resetUnknown");
  const reset = new Date(window.resetAt);
  // A reset that has passed has no time left to count down; the mod says so with its date instead.
  if (window.resetAt <= now) return t("limits.passed", { date: reset.toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) });
  if (weekly) return t("limits.resetsAt", { time: reset.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) });
  // Ceiled from a positive span, so the countdown is at least one minute and never reads 0.
  const minutes = Math.ceil((window.resetAt - now) / 60_000);
  const hours = Math.floor(minutes / 60);
  // Under an hour the countdown is minutes alone ("34분 후 초기화", not "0시간 34분 후 초기화"): the
  // sentence's hour figure and its unit are dropped, its own minutes unit and wording kept.
  if (hours === 0) return t("limits.resetsIn").replace(/\{hours\}[^{]*?(?=\{minutes\})/, "").split("{minutes}").join(String(minutes));
  // An exact hour is hours alone ("2시간 후 초기화", not "2시간 0분 후 초기화"): the minutes figure goes with
  // its unit, the one units.minutes spells, and the sentence's hours and wording stay.
  if (minutes % 60 === 0) {
    const unit = t("units.minutes").replace("{n}", "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const whole = t("limits.resetsIn").replace(new RegExp(`\\s*\\{minutes\\}\\s*${unit}`), "");
    if (unit && !whole.includes("{minutes}")) return whole.split("{hours}").join(String(hours));
  }
  return t("limits.resetsIn", { hours, minutes: minutes % 60 });
}

/**
 * One window's row. The reset comes first; with no exhaust forecast the pace follows it as a label, muted
 * when comfortable and amber when tight, as the mod's pane puts it. An exhaust forecast is a warning line
 * under the row instead. A window whose reset has passed keeps its last share, so it is marked stale.
 * `accountName` puts whose gauge it is into the accessible name.
 */
function limitsWindowRow(label, window, now, accountName = "") {
  const percent = `${Math.round(window.usedPercent * 10) / 10}%`;
  // A window of a day or more reads its reset as a weekday and clock; a shorter one as the time left.
  const reset = limitsReset(window, window.kind === "seven_day" || window.windowMinutes >= 1440, now);
  const name = accountName ? `${accountName} · ${label}` : label;
  const exhaustLeft = limitsExhaustLeft(window, now);
  const note = exhaustLeft === null ? "" : t("limits.exhaust", { time: limitsTimeLeft(exhaustLeft) });
  const level = note ? null : limitsPaceLevel(window, now);
  const pace = level ? t("limits.paceProjected", { percent: Math.round(window.projectedPercent) }) : "";
  const passed = Number.isFinite(window.resetAt) && window.resetAt <= now;
  // The bar and its figure take the mod's limitItemTone: amber from 80%, red from 95% or within the hour of running out.
  const tone = limitsNoteTone(window, exhaustLeft);
  const track = el("div", {
    class: "limits-track meter", role: "progressbar", tabindex: "0",
    "aria-label": name, "aria-valuemin": "0", "aria-valuemax": "100",
    "aria-valuenow": Math.max(0, Math.min(100, window.usedPercent)),
    "aria-valuetext": [percent, reset, pace, note].filter(Boolean).join(" · "), title: [name, percent, reset].join(" · "),
  });
  const fill = el("span", { class: "limits-fill meter-fill", "aria-hidden": "true" });
  fill.style.width = `${Math.max(0, Math.min(100, window.usedPercent))}%`;
  track.appendChild(fill);
  const parts = [el("span", { text: reset })];
  if (passed) parts.push(el("span", { class: "warn-text", text: t("limits.stale") }));
  if (pace) parts.push(level === "tight" ? el("span", { class: "warn-text", text: pace }) : el("span", { text: pace }));
  const foot = el("div", { class: "limits-window-foot" }, parts.flatMap((part, index) => (index ? [el("span", { class: "sep", text: " · " }), part] : [part])));
  // One line of a table: the window's name, its bar and figure, then when it resets; an exhaust warning runs under the bar.
  return el("div", { class: `limits-window${tone === "ink" ? "" : ` tone-${tone}`}` }, [
    el("div", { class: "limits-window-head" }, [
      el("span", { class: "limits-window-name", text: label, title: label }),
      track,
      el("span", { class: "limits-window-figure", text: percent }),
    ]),
    foot,
    note ? el("div", { class: tone === "ink" ? "limits-window-note" : `limits-window-note ${tone}-text`, text: note }) : null,
  ]);
}

/** The router's generic names for an account nobody named ("Claude account 2"): the pane says the number instead, as the mod does. */
const LIMITS_PLACEHOLDER = /^(?:Claude|ChatGPT|Google) account(?: \d+)?$/i;

/** A name as the limits pane shows it: control characters dropped, cut at `max` with an ellipsis (the mod's displayText). */
function limitsDisplay(value, max) {
  const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** A span of minutes in the mod's units: "30d", "5h", "45m" (its units.* wording). */
function limitsSpanName(minutes) {
  if (minutes % 1440 === 0) return t("units.days", { n: minutes / 1440 });
  if (minutes % 60 === 0) return t("units.hours", { n: minutes / 60 });
  return t("units.minutes", { n: minutes });
}

/**
 * A window's name as the mod's limitItemName gives it: the 5-hour and weekly names, a scoped window's own
 * label ("Fable", "Argon weekly"), else its span ("30d"). Only the windows the router reported are named.
 */
function limitsItemName(window) {
  if (window.kind === "five_hour") return t("limits.fiveHour");
  if (window.kind === "seven_day") return t("limits.weekly");
  if (window.kind === "scoped") return limitsDisplay(window.label || window.kind, 120);
  if (window.windowMinutes === 300) return t("limits.fiveHour");
  if (window.windowMinutes === 10080) return t("limits.weekly");
  if (window.windowMinutes > 0) return limitsSpanName(window.windowMinutes);
  return limitsDisplay(window.label || String(window.kind ?? "").replace(/_/g, " "), 120);
}

/** A window's name in its account: its own, and its span after it when another window of the account shares the name (Gemini's two "3P" windows). */
function limitsWindowName(windows, index) {
  const window = windows[index];
  const name = limitsItemName(window);
  const twin = windows.some((other, j) => j !== index && limitsItemName(other) === name);
  return twin && window.windowMinutes ? `${name} ${limitsItemName({ kind: "window", windowMinutes: window.windowMinutes })}` : name;
}

/** A window the router reported, as the pane reads it; null for a window with no share. */
function limitsUsageWindow(window) {
  if (!window || !Number.isFinite(window.used_percent)) return null;
  return {
    kind: window.kind,
    ...(window.label ? { label: window.label } : {}),
    usedPercent: window.used_percent,
    ...(Number.isFinite(window.window_minutes) ? { windowMinutes: window.window_minutes } : {}),
    // The API's reset and exhaust moments are in epoch seconds; the date helpers read milliseconds.
    ...(Number.isFinite(window.reset_at) ? { resetAt: window.reset_at * 1000 } : {}),
    ...(Number.isFinite(window.exhaust_at) ? { exhaustAt: window.exhaust_at * 1000 } : {}),
    ...(Number.isFinite(window.projected_percent) ? { projectedPercent: window.projected_percent } : {}),
  };
}

/** An account's name on the Status screen: the Claude login in the dashboard's language, else its label, else its provider's title and number. */
function limitsAccountName(entry, account) {
  // The router names the Claude app login in English ("Current Claude login"); the screen says it in its own language.
  if (entry.type === "anthropic" && account.id === "current") return t("providers.anthropicCurrentLogin");
  const label = limitsDisplay(account.label || account.email || "", 120);
  if (label && !LIMITS_PLACEHOLDER.test(label)) return label;
  return account.account === null || account.account === undefined ? entry.title : `${entry.title} ${account.account + 1}`;
}

/**
 * Whether an account's row needs a name: a provider's only account, with no label of its own, would
 * read as a made-up one ("Go 1" under "OpenCode Go"), so its windows stand under the provider instead.
 * The Claude login has a name of its own; a provider with several accounts numbers them apart.
 */
function limitsAccountNamed(entry, account) {
  if (!Array.isArray(entry.accounts) || entry.accounts.length !== 1) return true;
  if (entry.type === "anthropic" && account.id === "current") return true;
  const label = limitsDisplay(account.label || account.email || "", 120);
  return Boolean(label && !LIMITS_PLACEHOLDER.test(label));
}

/**
 * One account: its name with its state beside it, then a line per window. `credential` is the pool's entry
 * for the same account, so a cooldown or a rejected sign-in sits on the account's own row rather than in a
 * second list of the same accounts under the provider's name. The time of the figures is on the name's
 * tooltip; it is spelt out only where it matters, beside a stale mark.
 */
function limitsAccountRow(entry, account, now, credential) {
  const badges = [];
  if (account.inUse) badges.push(badge("first", t("limits.active")));
  // A cooling account with no time left would read "available again in 0s"; once its countdown is over it shows as ready.
  const cooledOff = account.state === "cooling" && !(account.cooldownSeconds > 0);
  const stated = account.paused || (account.state && account.state !== "ready" && !cooledOff);
  if (stated) badges.push(chatgptStateBadge(account));
  // The pool's word on the account, unless the account's own state already says it.
  else if (credential && credential.state === "quarantined") badges.push(badge("bad", t("pool.quarantined")));
  else if (credential && credential.state === "cooling" && credential.cooldownSeconds > 0) badges.push(badge("warn", t("pool.coolingFor", { duration: durationText(credential.cooldownSeconds) })));
  const read = Number.isFinite(account.at) && account.at > 0;
  const fetched = read ? t("limits.fetchedAt", { time: new Date(account.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) }) : t("limits.notFetched");
  if (entry.stale || account.stale || (account.quota && account.quota.stale)) {
    badges.push(badge("warn", t("limits.stale")));
    if (read) badges.push(el("span", { class: "limits-fetched", text: fetched }));
  }
  const named = limitsAccountNamed(entry, account);
  const name = named ? limitsAccountName(entry, account) : "";
  const windows = (account.windows || []).map(limitsUsageWindow).filter(Boolean);
  // One gauge per window the router reported; a window it did not report has no gauge, and an account with none has none.
  // A nameless row's gauges are named by their provider, so a screen reader still hears whose they are.
  const gauges = windows.map((window, index) => limitsWindowRow(limitsWindowName(windows, index), window, now, name || entry.title || ""));
  // An account with no figures says why only when no state above already does ("paused" needs no "no usage yet" after it).
  const empty = !gauges.length && !stated ? el("span", { class: "limits-empty", text: fetched }) : null;
  return el("div", { class: named ? "limits-account" : "limits-account unnamed" }, [
    named || badges.length ? el("div", { class: "limits-account-head" }, [
      named ? el("strong", { text: name, title: `${name} · ${fetched}` }) : null,
      badges.length ? el("div", { class: "limits-badges" }, badges) : null,
    ]) : null,
    gauges.length ? el("div", { class: "limits-windows", ...(named ? {} : { title: fetched }) }, gauges) : empty,
  ]);
}

/**
 * Claude rows come from limits. ChatGPT keeps all status accounts; only those in rotation are numbered.
 * The status and the limits are two reads, so a figure never outlives the status it is shown beside: a row
 * keeps its figures only while the status lists its account under the same id and not as paused or waiting
 * for a sign-in. The status's view wins for whose account it is and whether it is in use.
 * Status does not carry `limits`, so before the config loads a provider the limits leave out may be one
 * saved with limits off: it keeps its text lines. Once the config says the provider has limits, a ChatGPT
 * provider shows its accounts even without figures. Claude shows only the rows the limits list, so an
 * unlisted Claude provider keeps its text lines too.
 */
function providerLimits(name) {
  if (!limitsSnapshot || !Array.isArray(limitsSnapshot.providers) || !status) return null;
  const configured = currentConfig && currentConfig.providers && currentConfig.providers[name];
  const provider = configured || (status.providers && status.providers[name]);
  if (!provider || provider.limits === false) return null;
  if (provider.type === "anthropic" && provider.auth !== "claude-code" && !provider.authSource) return null;
  const listed = limitsSnapshot.providers.find((item) => item.provider === name);
  // A ChatGPT provider the config says has limits keeps its account rows without figures; any other provider the read does not list keeps its text lines.
  if (!listed && (!configured || provider.type !== "chatgpt")) return null;
  const live = status.providers && status.providers[name];
  const entry = { ...(listed || { type: provider.type, title: "GPT", accounts: [] }),
    stale: limitsSnapshotStale || (provider.type === "chatgpt" && Boolean(status.chatgpt && status.chatgpt.staleReason && status.chatgpt.staleReason[name])),
  };
  if (entry.type === "anthropic") {
    // Without the status's account list there is nothing to check the limits against; keep them as they are.
    const listedAccounts = status.claude && status.claude.accounts;
    if (!Array.isArray(listedAccounts)) return entry.accounts.length ? entry : null;
    const rows = entry.accounts.flatMap((figures) => {
      const listed = figures.id === undefined ? undefined : listedAccounts.find((item) => item.id === figures.id);
      if (!listed || listed.paused || listed.state === "paused" || listed.state === "needs-login") return [];
      return [{ ...figures, ...(listed.label ? { label: listed.label } : {}), inUse: listed.inUse === true }];
    });
    return rows.length ? { ...entry, accounts: rows } : null;
  }
  if (entry.type === "chatgpt") {
    const accounts = status.chatgpt && status.chatgpt.accounts && status.chatgpt.accounts[name];
    if (!accounts) return entry.accounts.length ? entry : null;
    let number = 0;
    const rows = accounts.map((account) => {
      const index = account.state !== "paused" && account.state !== "needs-login" ? number++ : null;
      const figures = index === null || account.id === undefined ? null : entry.accounts.find((item) => item.id === account.id);
      return { ...account, account: index, windows: figures ? figures.windows : [], at: figures ? figures.at : 0, ...(figures && figures.stale ? { stale: true } : {}) };
    });
    return rows.length ? { ...entry, accounts: rows } : null;
  }
  // Google, OpenCode Go, MiniMax and Grok: the status has no account list these rows can join by id, so each row stands as the
  // read gave it. The read itself leaves out paused and signed-out Google accounts; a provider that needs a sign-in shows its text line.
  if (live && live.needsLogin) return null;
  return entry.accounts.length ? entry : null;
}

/**
 * Reads /api/limits beside the status read, never ahead of it. A read still running is not doubled behind
 * a slow provider, and a failed read keeps the last reading on screen, marked stale, instead of dropping
 * its gauges. The screen is redrawn when the read lands.
 */
function refreshLimits() {
  if (limitsRead) return limitsRead;
  limitsRead = api("/api/limits").then((body) => {
    limitsSnapshot = body;
    limitsSnapshotStale = false;
  }, () => {
    limitsSnapshotStale = limitsSnapshot !== null;
  }).finally(() => {
    limitsRead = null;
    if (status) renderHealthProviders();
    if (status) refreshProviderUsage();
  });
  return limitsRead;
}

async function refreshHealth() {
  // The status is what the screen waits for; the limits are read beside it and fill their gauges when they land.
  const statusRead = api("/api/status");
  void refreshLimits();
  try {
    status = await statusRead;
  } catch (error) {
    $("#health-desktop").replaceChildren(el("div", { class: "stat-value" }, [badge("bad", t("health.disconnected"))]));
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
  // The two overview tiles: whether Claude Desktop goes through the router, and how many requests it has handled.
  const desktop = $("#health-desktop");
  desktop.replaceChildren(
    el("div", { class: "stat-value" }, [status.settings.pointsAtRouter ? badge("ok", t("health.connected")) : badge("bad", t("health.notConnected"))]),
    el("p", { class: "stat-sub", text: status.settings.pointsAtRouter ? t("health.connectedHelp") : t("health.notConnectedHelp") }),
  );
  $("#health-requests").replaceChildren(el("div", { class: "stat-value", text: t("health.requestsFmt", Object.fromEntries(Object.entries(status.stats || {}).map(([key, value]) => [key, typeof value === "number" ? value.toLocaleString() : value]))) }));
  renderHealthProviders();
  renderDiagnostics();
  if (clientsLoaded) renderClients();
  if (modState.settings) renderModNotice();
  const details = $("#health-details");
  // A start this page recorded is over once the router says so — a failure included — so the button
  // is not left saying "running" with no way back (G-D07).
  if (updateState.check && updateState.check.running && status.autoUpdate && status.autoUpdate.running === false) {
    updateState.check = { ...updateState.check, running: false };
  }
  modRedraw(details, [
    versionRow(),
    autoUpdateRow(),
    priorityRow(),
    // Which files answer, and since when: the only way to see that an update actually replaced the router.
    ...(status.runtime ? [cell(t("health.runtime"), null, [el("span", { class: "cell-sub mono", text: status.runtime.router || "?" }), new Date(status.runtime.startedAt).toLocaleString()])] : []),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.routes") }), el("span", { class: "v", text: String(status.routes) })]),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.cli") }), el("span", { class: "v", text: status.cliVersion })]),
  ]);
}

// ---- Diagnostics: what the router says is in the way, and a copy that carries no secrets -------

/** One readiness problem in words, with the action that clears it; an unknown code stays as it is. */
function readinessProblemText(code) {
  if (code === "settings") return t("health.diagnosticSettings");
  if (code === "upstream") return t("health.diagnosticUpstream");
  if (code === "picker-ca") return t("health.diagnosticPickerCa");
  if (code === "picker-proxy") return t("health.diagnosticPickerProxy");
  if (code === "config") return t("health.diagnosticConfig");
  if (String(code).startsWith("provider:")) return t("health.diagnosticProvider", { name: String(code).slice(9) });
  return String(code);
}
/**
 * The problems the router reports, and the validation errors in its config: readiness once said
 * "ready" while nothing could connect and did not say why the picker showed no models (G-D08), and a
 * config the router could not read was adopted without a word (G-D14). A reason and its fix, or
 * nothing at all.
 */
function renderDiagnostics() {
  const box = $("#health-diagnostics");
  const wrap = $("#health-diagnostics-section");
  if (!box || !wrap || !status) return;
  const problems = (status.readiness && Array.isArray(status.readiness.problems)) ? status.readiness.problems : [];
  const configErrors = (status.config && Array.isArray(status.config.errors)) ? status.config.errors : [];
  const envProxy = (status.envProxy && Array.isArray(status.envProxy.set)) ? status.envProxy.set : [];
  wrap.hidden = problems.length === 0 && configErrors.length === 0 && envProxy.length === 0;
  if (wrap.hidden) { box.replaceChildren(); return; }
  const rows = problems.map((code) => cell(readinessProblemText(code), badge("warn", String(code))));
  for (const error of configErrors) rows.push(cell(t("health.diagnosticConfig"), badge("bad", "config"), [el("span", { class: "cell-sub mono", text: String(error) })]));
  // Not a fault: a proxy that is set but not needed changes nothing. Said anyway, because an
  // upstream call that needed one would otherwise fail with no hint why (G-D11).
  if (envProxy.length) rows.push(cell(t("health.diagnosticEnvProxy", { list: envProxy.join(", ") }), badge("warn", "env-proxy")));
  box.replaceChildren(...rows);
}
/**
 * What a person can paste into a report without handing over a credential: versions, readiness,
 * config errors, proxy state (whether it points here, never the keys) and provider names with their
 * connection state. Token values, headers, request bodies and file paths stay out (G-D15).
 */
function diagnosticBundle() {
  const providers = Object.entries((status && status.providers) || {}).map(([name, entry]) => ({
    name,
    type: entry.type || null,
    reachable: entry.reachable === undefined ? null : entry.reachable,
    usable: entry.usable === undefined ? null : entry.usable,
    needsLogin: Boolean(entry.needsLogin),
  }));
  return {
    app: "ClaudeRipple",
    version: status.version,
    cli: status.cliVersion,
    readiness: status.readiness || null,
    config: status.config || null,
    envProxy: status.envProxy || null,
    settings: { pointsAtRouter: Boolean(status.settings && status.settings.pointsAtRouter) },
    autoUpdate: status.autoUpdate ? { enabled: Boolean(status.autoUpdate.enabled), running: Boolean(status.autoUpdate.running), kind: status.autoUpdate.kind || null, failed: Boolean(status.autoUpdate.lastError) } : null,
    listen: status.listen || null,
    providers,
  };
}
async function copyDiagnostics() {
  if (!status) return;
  if (!confirm(t("health.copyDiagnosticsConfirm"))) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(diagnosticBundle(), null, 2));
    toast(t("health.copyDiagnosticsDone"));
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  }
}
const diagnosticsCopy = $("#diagnostics-copy");
if (diagnosticsCopy) diagnosticsCopy.addEventListener("click", () => void copyDiagnostics());

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
    const out = await configRequest(next);
    currentConfig = next;
    if (status.autoUpdate) status.autoUpdate.enabled = enabled;
    configSaved(out, t("common.saved"));
  } catch (error) {
    toast(t("common.saveFailed"), true, error.message);
  } finally {
    autoUpdateSaving = false;
    await refreshHealth();
    const current = document.querySelector('[data-key="auto-update"]');
    if (current) { current.disabled = !status.autoUpdate; current.checked = status.autoUpdate?.enabled !== false; }
  }
}

// How much CPU priority the router and the phone host ask Windows for (config processPriority,
// Normal unless set). Task Scheduler had started them below Normal, and a build holding every core
// starved the router until an update could not reach it (2026-10-29). High puts ClaudeRipple ahead
// of other programs, so choosing it asks first and the row says so while it is on.
const PRIORITY_LABEL = { "below-normal": "priority.belowNormal", normal: "priority.normal", "above-normal": "priority.aboveNormal", high: "priority.high", idle: "priority.idle", realtime: "priority.realtime" };
let prioritySaving = false;
function priorityRow() {
  const state = status.processPriority;
  // Older routers do not report it, and only Windows has these levels.
  if (!state || !state.supported) return null;
  const items = ["below-normal", "normal", "above-normal", "high"].map((value) => ({ value, label: t(PRIORITY_LABEL[value]) }));
  const select = modSelect("process-priority", items, state.setting, t("priority.label"), (value) => void savePriority(value, select));
  select.disabled = prioritySaving;
  const notes = [t("priority.help")];
  if (state.setting === "high") notes.push(el("span", { class: "cell-sub warn-text", text: t("priority.highWarning") }));
  // Task Manager or another program can change it underneath; say what is in effect.
  if (state.current && state.current !== state.setting) notes.push(el("span", { class: "cell-sub warn-text", text: t("priority.current", { level: t(PRIORITY_LABEL[state.current]) }) }));
  return cell(t("priority.label"), select, notes);
}
async function savePriority(value, select) {
  const state = status.processPriority;
  if (prioritySaving || !state || value === state.setting) return;
  if (value === "high" && !confirm(t("priority.highConfirm"))) { select.value = state.setting; return; }
  prioritySaving = true;
  select.disabled = true;
  try {
    const next = await api("/api/config");
    next.processPriority = value;
    const out = await configRequest(next);
    currentConfig = next;
    state.setting = value;
    configSaved(out, t("common.saved"));
  } catch (error) {
    toast(t("common.saveFailed"), true, error.message);
  } finally {
    prioritySaving = false;
    await refreshHealth();
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
  // An install that ran and failed is not "the latest version": the reason stays in reach, and the
  // button is the retry (G-D07). The router's own text is shown, as it is the only detail there is.
  const failed = status.autoUpdate && status.autoUpdate.lastError && !status.autoUpdate.running && !updateState.busy;
  if (failed && button) note = `${t("update.lastFailed")} ${shortError(status.autoUpdate.lastError)}`;
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
function credentialLine(name, shown) {
  // An account drawn as its own row below carries its state there (limitsAccountRow); the line keeps the rest.
  const pool = ((status && status.credentials && status.credentials[name]) || []).filter((c) => !(shown && c.id !== undefined && shown.has(c.id)));
  if (!pool.length) return null;
  const parts = pool.map((c) => {
    // The router names the Claude login in English ("Current Claude session") and an account nobody named "Claude account"; the screen says them in its language.
    const who = c.id === "current" ? t("providers.anthropicCurrentLogin") : c.label === "Claude account" ? t("providers.claudeAccountDefault") : c.label || c.id;
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
  if (live && live.exhaustion) {
    // The router's reason is its own English word; the dashboard says it in its language, with the mod's wording (workers.ts unavailableReason).
    const reasons = { insufficient_balance: "providerStatus.insufficientBalance", billing_exhausted: "providerStatus.billingExhausted", quota_exhausted: "providerStatus.quotaExhausted" };
    return { level: "warn", text: `${t(reasons[live.exhaustion.reason] || "providerStatus.unavailable")} · ${new Date(live.exhaustion.until).toLocaleTimeString()}` };
  }
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
    const limits = providerLimits(name);
    // Older routers and a never-read limits list keep the text lines; gauges replace them only where they show figures.
    const figures = Boolean(limits && limits.accounts.some((account) => (account.windows || []).length));
    const quota = figures ? null : quotaLine(name);
    if (quota) lines.push(el("span", { class: "cell-sub", text: quota }));
    // Claude subscription accounts, one line each: the current login and every account added here.
    // Before the config has loaded the rows come from the status, which names the sign-in source
    // rather than the auth mode. The gauges replace these lines when limits are available.
    if (!limits && provider.type === "anthropic" && (provider.auth === "claude-code" || (live && live.authSource))) {
      const usage = ((status && status.claude && status.claude.accounts) || [])
        .map((account) => ({ account, text: chatgptQuotaText(account.quota) }))
        .filter(({ text }) => text)
        .map(({ account, text }) => el("div", { text: `${claudeAccountLabel(account)} · ${text}` }));
      if (usage.length) lines.push(el("div", { class: "cell-sub account-usage" }, usage));
    }
    // A cooldown or quarantine is not in the gauges: an account with a row says it on that row, any other stays in the line.
    const shown = limits ? new Set(limits.accounts.map((account) => account.id).filter((id) => id !== undefined)) : null;
    const pool = credentialLine(name, shown);
    if (pool) lines.push(pool);
    if (live && live.needsLogin && provider.type === "chatgpt") {
      lines.push(el("div", { class: "cell-actions" }, [
        chatgptLoginButton(() => renderHealthProviders()),
        chatgptLoginMessage ? el("span", { class: "small", text: chatgptLoginMessage }) : null,
      ]));
    }
    // The row opens the provider's own page; a button inside it keeps its own click. The dot is the vendor's hue, as on the mod's band.
    const dot = el("span", { class: "vendor-dot", "aria-hidden": "true" });
    dot.style.color = providerHue(name, provider);
    const title = el("span", { class: "cell-label provider-title" }, [dot, el("span", { text: providerTitle(name, provider) })]);
    const row = cell(title, [providerState(name, provider), chevronIcon()], lines, "provider-status link");
    row.tabIndex = 0;
    const open = (event) => { if (!event.target.closest("button, a")) openProvider(name, provider); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target === row) open(event); });
    // Only the header opens the provider; the accounts below take the card's full width.
    if (!limits) return row;
    const now = Date.now();
    const credentials = (status && status.credentials && status.credentials[name]) || [];
    const credentialOf = (account) => (account.id === undefined ? undefined : credentials.find((c) => c.id === account.id));
    return el("div", { class: "provider-block" }, [row, el("div", { class: "provider-limits" }, limits.accounts.map((account) => limitsAccountRow(limits, account, now, credentialOf(account))))]);
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
  renderClientPickerOrder(picker.enabled);
  renderModelSlots();
  renderAutoClassifier();
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
  const mapped = Object.entries(currentConfig.routes || {}).map(([source, route]) => {
    const target = (groups.find((group) => group.name === route.provider) || { models: [] }).models.find((model) => model.id === route.model) || { id: route.model };
    // Where a model goes when its provider cannot answer is part of what routes it: shown here, not
    // only enforced by the router, and left to the config file rather than made a form (U36).
    const fallbacks = (route.fallbacks || []).map((fallback) => {
      const model = (groups.find((group) => group.name === fallback.provider) || { models: [] }).models.find((item) => item.id === fallback.model) || { id: fallback.model };
      return `${labelOf(model)} · ${providerLabel(fallback.provider, currentConfig.providers[fallback.provider] || {})}`;
    });
    return cell(
      labelOf(claudeModels.find((model) => model.id === source) || { id: source }),
      el("span", { text: labelOf(target) }),
      fallbacks.length ? el("span", { class: "cell-sub", text: t("slots.fallbacks", { list: fallbacks.join(" → ") }) }) : null,
    );
  });
  $("#client-claude-code-rows").replaceChildren(...(mapped.length ? mapped : [el("div", { class: "cell-note", text: t("slots.noChanges") })]));
}
// The five-second status poll re-runs the Clients screen. Rebuilding the model controls then would
// replace a window field being typed in — losing the value and the focus — though the poll changes
// nothing they are drawn from. Each render remembers what it drew and repeats only for different
// data; the slot rows also read each provider's measured search ability, so that is part of their key.
let pickerModelsDrawnFor = { key: null };
let modelSlotsDrawnFor = { key: null };
// A window field being typed into when a config or catalogue change rebuilds the rows: the text
// and the caret stay, and the saved value does not overwrite them before the person is done (B20).
const pickerWindowDrafts = new Map();
function renderClientPickerModels(enabled) {
  const card = $("#client-picker-models-card");
  card.hidden = !enabled;
  if (!enabled) return;
  const box = $("#client-picker-models");
  const checked = new Set(((currentConfig.cli && currentConfig.cli.extraModels) || []).map((item) => item.model));
  const groups = groupedModels(currentConfig);
  const key = JSON.stringify([
    [...checked].sort(),
    groups.map((group) => [group.name, providerLabel(group.name, group.provider), group.models.map((model) => [
      model.id, labelOf(model), discoveredContextWindow(group.name, model.id) ?? null,
      savedContextWindow(model.id) ?? null, pickerContextWindows.catalogWindows[model.id] ?? null,
      pickerContextWindows.windows[model.id] ?? null,
    ])]),
  ]);
  // Typing in a window changes none of this, and the catalogue arrives once with the screen, so a
  // repeat poll — or a save elsewhere on this screen — has nothing new to draw. Nor does a redraw
  // while picker saves are open: it would show what the first of them stored and undo the ticks the
  // waiting one is about to read.
  if ((key === pickerModelsDrawnFor.key || pickerSavesOpen > 0) && box.childElementCount) return;
  const typing = document.activeElement;
  const typingModel = typing && typing.classList && typing.classList.contains("model-window") && box.contains(typing) ? typing.dataset.model : null;
  const typingCaret = typingModel ? typing.selectionStart : null;
  const known = new Set(groups.flatMap((group) => group.models.map((model) => model.id)));
  for (const id of [...pickerWindowDrafts.keys()]) if (!known.has(id)) pickerWindowDrafts.delete(id);
  box.replaceChildren();
  for (const group of groups) for (const model of group.models) {
    const input = el("input", { type: "checkbox", checked: checked.has(model.id) });
    input.dataset.model = model.id;
    input.dataset.provider = group.name;
    input.dataset.name = labelOf(model);
    const discovered = discoveredContextWindow(group.name, model.id);
    const saved = savedContextWindow(model.id);
    const catalogWindow = pickerContextWindows.catalogWindows[model.id];
    // The catalogue's figure is the one in use while the router resolves exactly it; a saved
    // override (or a route window) makes the two differ, and the field then shows the resolved value.
    const catalogApplied = catalogWindow !== undefined && pickerContextWindows.windows[model.id] === catalogWindow;
    const draft = pickerWindowDrafts.get(model.id);
    // Always editable. It shows the number the router uses; emptying it, or typing the catalogue's
    // own figure, saves no override and goes back to the official value (2026-10-30).
    const windowField = el("input", {
      type: "number", class: "model-window", min: "1", step: "1000",
      value: draft !== undefined ? draft : catalogApplied ? String(catalogWindow) : saved !== undefined ? String(saved) : "",
      placeholder: discovered !== undefined ? String(discovered) : t("slots.windowGlobal"),
      title: t(catalogApplied ? "slots.windowCodex" : "slots.windowHelp"),
    });
    const windowNote = catalogApplied ? el("small", { class: "pm-note", text: t("slots.windowCodex") }) : null;
    windowField.hidden = !input.checked;
    if (windowNote) windowNote.hidden = !input.checked;
    windowField.dataset.model = model.id;
    windowField.addEventListener("input", () => pickerWindowDrafts.set(model.id, windowField.value));
    windowField.addEventListener("change", () => void saveClientPickerModels());
    input.addEventListener("change", () => {
      windowField.hidden = !input.checked;
      if (windowNote) windowNote.hidden = !input.checked;
      void saveClientPickerModels();
    });
    // Two lines: the name owns the first — on one line it was the thing that collapsed, down to
    // "GPT…" — and the provider and the window share the second; the catalogue note, when there is
    // one, takes a third of its own (style.css places it: an inline style is dropped by the CSP).
    // The field sits outside the <label>, because inside it every click toggles the checkbox instead
    // of reaching the field.
    box.appendChild(el("div", { class: "picker-model", title: model.id }, [
      el("label", { class: "pm-main" }, [input, el("span", { text: labelOf(model) })]),
      el("small", { text: providerLabel(group.name, group.provider) }),
      windowField,
      windowNote,
    ]));
  }
  if (!box.childElementCount) box.appendChild(hint(t("slots.noProviderModels")));
  pickerModelsDrawnFor = { key };
  // The person was typing here before the rows were rebuilt: the field has their text back, and the
  // caret goes where it was so the next keystroke continues the number.
  if (typingModel) {
    const again = box.querySelector(`.model-window[data-model="${CSS.escape(typingModel)}"]`);
    if (again && !again.hidden) {
      again.focus();
      if (typingCaret !== null) { try { again.setSelectionRange(typingCaret, typingCaret); } catch { /* number inputs have no selection */ } }
    }
  }
}
// The order the app picker lists the added models in: it shows them after Claude's own, in the
// order `cli.extraModels` stores them (picker.ts appends them as stored). A reorder not yet saved is
// `pickerOrderPending`; the list shows it at once, and the save that carries it clears it.
let pickerOrderDrawnFor = { key: null };
let pickerOrderPending = null;
let pickerOrderFocus = null;
/** The added models in picker order. Claude's own ids are left out: those keep their own place there. */
function pickerOrderIds() {
  const native = new Set(claudeModels.map((model) => model.id));
  const known = allKnownModelIds(currentConfig);
  const entries = orderPickerEntries((currentConfig.cli && currentConfig.cli.extraModels) || [], pickerOrderPending || []);
  return [...new Set(entries.map((entry) => entry.model))].filter((id) => known.has(id) && !native.has(id));
}
function renderClientPickerOrder(enabled) {
  const card = $("#client-picker-order-card");
  const ids = enabled && currentConfig ? pickerOrderIds() : [];
  // One model has no order to choose.
  card.hidden = ids.length < 2;
  if (card.hidden) { pickerOrderDrawnFor = { key: null }; return; }
  const box = $("#client-picker-order");
  const entries = (currentConfig.cli && currentConfig.cli.extraModels) || [];
  const rows = ids.map((id) => {
    const entry = entries.find((item) => item.model === id);
    const owner = pickerOwner(currentConfig, id);
    return { id, name: (entry && entry.name) || id, provider: owner ? providerLabel(owner, currentConfig.providers[owner] || {}) : "" };
  });
  const key = JSON.stringify(rows);
  if (key === pickerOrderDrawnFor.key && box.childElementCount) return;
  // An arrow that has focus when the list is rebuilt for any other reason (a poll, a failed save
  // putting the old order back) keeps it the same way a move does.
  const active = document.activeElement;
  const activeKey = active && box.contains(active) ? active.getAttribute("data-key") : null;
  if (!pickerOrderFocus && activeKey && activeKey.startsWith("picker-order:")) {
    const at = activeKey.lastIndexOf(":");
    pickerOrderFocus = { id: activeKey.slice("picker-order:".length, at), suffix: activeKey.slice(at + 1) };
  }
  box.replaceChildren(...rows.map((row, index) => {
    const move = (delta, suffix) => {
      const next = rows.map((item) => item.id);
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      pickerOrderPending = next;
      pickerOrderFocus = { id: row.id, suffix };
      renderClientPickerOrder(true);
      void saveClientPickerModels(false);
    };
    const button = (suffix, text, labelKey, disabled, delta) => el("button", {
      type: "button", class: "btn secondary compact", "data-key": `picker-order:${row.id}:${suffix}`, text,
      "aria-label": t(labelKey, { name: row.name }), title: t(labelKey, { name: row.name }),
      ...(disabled ? { disabled: "" } : {}), onclick: () => move(delta, suffix),
    });
    return el("li", { class: "picker-order-item" }, [el("div", { class: "po-row", title: row.id }, [
      el("span", { class: "po-name", text: row.name }),
      row.provider ? el("small", { text: row.provider }) : null,
      el("div", { class: "rung-actions" }, [
        button("up", "↑", "slots.pickerMoveUp", index === 0, -1),
        button("down", "↓", "slots.pickerMoveDown", index === rows.length - 1, 1),
      ]),
    ])]);
  }));
  pickerOrderDrawnFor = { key };
  // The button just pressed is rebuilt with its row; keyboard focus follows the row, onto the other
  // arrow once this one has reached the end.
  if (pickerOrderFocus) {
    const { id, suffix } = pickerOrderFocus;
    pickerOrderFocus = null;
    const find = (which) => box.querySelector(`[data-key="${CSS.escape(`picker-order:${id}:${which}`)}"]`);
    const same = find(suffix);
    const target = same && !same.disabled ? same : find(suffix === "up" ? "down" : "up");
    if (target) target.focus();
  }
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
  const groups = groupedModels(currentConfig);
  const key = JSON.stringify([
    MODEL_SLOTS.map((slot) => chosen[slot] || ""),
    searchIntercepted ? 1 : 0,
    currentConfig.webSearch ? [currentConfig.webSearch.provider, currentConfig.webSearch.model] : null,
    groups.map((group) => [group.name, providerLabel(group.name, group.provider), group.models.map((model) => [
      model.id, labelOf(model), providerCannotSearch(group.name, model.id),
      Boolean(currentConfig.providers[group.name] && currentConfig.providers[group.name].type === "anthropic"),
    ])]),
  ]);
  // A provider's search ability is the only thing here the status poll can change; an unchanged key
  // means the selects already show this pass. Replacing them would take the focus off one mid-use.
  if (key === modelSlotsDrawnFor.key && rows.childElementCount) return;
  const nodes = MODEL_SLOTS.map((slot) => {
    const select = el("select", {});
    select.appendChild(el("option", { value: "", text: t("slots.slotDefault") }));
    for (const group of groups) for (const model of group.models) {
      const option = el("option", { value: model.id, text: `${labelOf(model)} · ${providerLabel(group.name, group.provider)}` });
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
  modelSlotsDrawnFor = { key };
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
    const option = el("option", { value: webSearchChoice(group.name, model.id), text: `${labelOf(model)} · ${providerLabel(group.name, group.provider)}` });
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
    const out = await configRequest(next);
    currentConfig = next;
    renderModelSlots();
    configSaved(out, t("slots.webSearchSaved"));
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
    const out = await configRequest(next);
    currentConfig = next;
    // Saying "saved" over a choice that will make every search fail is the same silent no-op this
    // screen was already guilty of once. The label on the option warns before the fact; this catches
    // a session that already had it selected. With a web search backend set the search never
    // reaches `smallFast`, so there is nothing to warn about.
    const savedModels = next.cli.models;
    const owners = savedModels.smallFast && !next.webSearch ? providersOffering(next, savedModels.smallFast) : [];
    const warning = owners.length && providerCannotSearch(owners[0], savedModels.smallFast) ? t("slots.noWebSearchWarn") : undefined;
    configSaved(out, t("slots.slotSaved"), warning);
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

// ---- Auto mode classifier ---------------------------------------------------------------
//
// `autoModeClassifier` (ARCHITECTURE §2) takes Auto mode's security check off the model Claude Code
// picked for it. The two rows are its two stages: the first stage's quick yes/no, and the second
// stage together with every other classifier request. Each row is a provider and model, or Claude
// Code's own choice. The config can spell the same two rows several ways, so the two functions
// below are the only translation between them.

/** The two rows a setting shows, `{ first, rest }`: each a target, or null for Claude Code's own. */
function classifierRowsOf(settings) {
  if (!settings || typeof settings !== "object") return { first: null, rest: null };
  const pick = (target) => ({ provider: target.provider, model: target.model, ...(target.effort ? { effort: target.effort } : {}) });
  const rest = settings.provider && settings.model ? pick(settings) : null;
  const stage1 = settings.stage1;
  // Without `stage1` the first stage follows the main target, so both rows show it.
  if (stage1 === undefined) return { first: rest, rest };
  return { first: stage1 && typeof stage1 === "object" ? pick(stage1) : null, rest };
}
/** The setting two rows save, or undefined when both are Claude Code's own and the field goes. */
function classifierSettingOf(first, rest) {
  if (!first && !rest) return undefined;
  if (!rest) return { stage1: first };
  if (!first) return { ...rest, stage1: "native" };
  const same = first.provider === rest.provider && first.model === rest.model && (first.effort || "") === (rest.effort || "");
  return same ? { ...rest } : { ...rest, stage1: first };
}
/** Whether either row of a setting names this provider. */
function classifierNames(settings, provider) {
  const rows = classifierRowsOf(settings);
  return [rows.first, rows.rest].some((row) => row && row.provider === provider);
}
/** The setting once this provider is gone: a row that named it is Claude Code's own again, and the
 * other row is kept. Undefined when neither row has a target left. */
function classifierWithout(settings, provider) {
  const rows = classifierRowsOf(settings);
  const kept = (row) => (row && row.provider === provider ? null : row);
  return classifierSettingOf(kept(rows.first), kept(rows.rest));
}

// Claude Code refuses these as its own classifier because the API's safeguards refuse the second
// stage on them (CLI 2.1.310; measured for Sonnet 5.5, ARCHITECTURE §2). They answer the first.
const CLASSIFIER_REFUSES_STAGE2 = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5"]);

// A Claude account-pool provider answers with whatever the signed-in account can use, so one without
// a model list is offered with the Claude catalogue. A list would make it the routing owner of those
// ids for every request, not just this one, which is why a classifier's own provider has none.
function classifierGroups(config) {
  const groups = groupedModels(config);
  for (const [name, provider] of Object.entries(config.providers || {})) {
    if (provider.type !== "anthropic" || !isTargetProvider(provider) || modelsOf(provider).length) continue;
    groups.push({ name, provider, models: claudeModels.map((model) => ({ id: model.id, name: labelOf(model) })) });
  }
  return groups;
}

function classifierRow(stage, saved, groups) {
  const target = el("select", {});
  target.appendChild(selectOption("", t("classifier.native")));
  let found = false;
  for (const group of groups) {
    const optgroup = el("optgroup", { label: providerLabel(group.name, group.provider) });
    for (const model of group.models) {
      const option = selectOption(JSON.stringify([group.name, model.id]), labelOf(model));
      if (stage === "rest" && CLASSIFIER_REFUSES_STAGE2.has(model.id)) option.textContent += ` (${t("classifier.refusesStage2")})`;
      if (saved && saved.provider === group.name && saved.model === model.id) found = true;
      optgroup.appendChild(option);
    }
    target.appendChild(optgroup);
  }
  // A target the config names but no provider offers any more must not read as Claude Code's own:
  // saving the row unchanged would then quietly hand the check back.
  if (saved && !found) target.appendChild(selectOption(JSON.stringify([saved.provider, saved.model]), `${saved.provider} / ${saved.model} (?)`));
  target.value = saved ? JSON.stringify([saved.provider, saved.model]) : "";

  const effort = el("select", { class: "classifier-effort" });
  // "" saves no effort, and the request keeps the effort Claude Code gave it. A saved level the
  // catalogue does not list is kept on first draw, so opening the page never rewrites it.
  const sync = (prior, keepUnlisted) => {
    const picked = routeFromTarget(target.value);
    const levels = picked ? effortLevelsFor(picked.provider, picked.model) : [];
    const shown = keepUnlisted && prior && !levels.includes(prior) ? [...levels, prior] : levels;
    effort.replaceChildren(selectOption("", t("classifier.effortDefault")), ...shown.map((level) => selectOption(level, level)));
    effort.value = shown.includes(prior) ? prior : "";
    effort.disabled = shown.length === 0;
  };
  sync(saved && saved.effort, true);
  target.onchange = () => { sync(effort.value, false); void saveAutoClassifier(); };
  effort.onchange = () => void saveAutoClassifier();
  target.dataset.classifier = stage;
  effort.dataset.classifierEffort = stage;
  target.setAttribute("aria-label", t(`classifier.${stage}`));
  effort.setAttribute("aria-label", t("slots.th.effort"));
  return cell(t(`classifier.${stage}`), [target, effort], t(`classifier.${stage}Help`), "slot-row classifier-row");
}

function renderAutoClassifier() {
  const box = $("#client-auto-classifier");
  if (!box || !currentConfig) return;
  const rows = classifierRowsShown();
  const groups = classifierGroups(currentConfig);
  box.replaceChildren(classifierRow("first", rows.first, groups), classifierRow("rest", rows.rest, groups));
  const note = $("#client-auto-classifier-note");
  const pool = Object.values(currentConfig.providers || {}).some((provider) => provider.type === "anthropic" && isTargetProvider(provider));
  if (note) note.hidden = pool;
}

function classifierRowValue(stage) {
  const target = $(`#client-auto-classifier select[data-classifier="${stage}"]`);
  const effort = $(`#client-auto-classifier select[data-classifier-effort="${stage}"]`);
  const picked = target ? routeFromTarget(target.value) : null;
  if (!picked) return null;
  return effort && effort.value ? { ...picked, effort: effort.value } : picked;
}

// A choice is read from the rows when it is made, before anything is awaited: a save that lands
// redraws the rows from what it stored, so a later choice read after that would be the earlier one.
// Saves run one at a time, and one that a newer choice has overtaken is dropped, so the last choice
// is the one stored. Until it is stored the rows are drawn from it: the five-second status refresh
// redraws them too, and drawn from the stored setting it would put the earlier value back in a row
// that the next choice then reads and saves.
let classifierSaveGeneration = 0;
let classifierSaving = Promise.resolve();
let classifierPending = null;
function classifierRowsShown() {
  return classifierRowsOf(classifierPending ? classifierPending.setting : currentConfig.autoModeClassifier);
}
function saveAutoClassifier() {
  if (!currentConfig) return classifierSaving;
  const setting = classifierSettingOf(classifierRowValue("first"), classifierRowValue("rest"));
  classifierPending = { setting };
  const generation = ++classifierSaveGeneration;
  classifierSaving = classifierSaving.then(async () => {
    if (generation !== classifierSaveGeneration) return;
    try {
      const next = clone(await latestConfig());
      if (generation !== classifierSaveGeneration) return;
      if (setting) next.autoModeClassifier = setting;
      else delete next.autoModeClassifier;
      await configRequest(next);
      currentConfig = next;
      if (generation !== classifierSaveGeneration) return;
      classifierPending = null;
      renderAutoClassifier();
      toast(t("classifier.saved"));
    } catch (error) {
      if (generation === classifierSaveGeneration) classifierPending = null;
      toast(t("common.saveFailed"), true, error.message);
    }
  });
  return classifierSaving;
}

function clientPickerSelections() {
  return $all("#client-picker-models input[type=checkbox]:checked").map((input) => {
    const field = $(`#client-picker-models input.model-window[data-model="${CSS.escape(input.dataset.model)}"]`);
    const catalogWindow = pickerContextWindows.catalogWindows[input.dataset.model];
    const typed = field && field.value.trim() ? Number(field.value) : NaN;
    const value = Number.isFinite(typed) && typed > 0 ? Math.floor(typed) : undefined;
    // An empty field, or the catalogue's own figure, is no override for a catalogue-backed model:
    // the entry stores no window and the router keeps following the catalogue. Another provider
    // keeps its old fallback to the window its provider declares (2026-10-30).
    const contextWindow = value !== undefined && value !== catalogWindow
      ? value
      : catalogWindow !== undefined ? undefined : discoveredContextWindow(input.dataset.provider, input.dataset.model);
    return { id: input.dataset.model, name: input.dataset.name, provider: input.dataset.provider, contextWindow };
  });
}
// One picker save at a time, each built from the screen as it is when that save starts. Two quick
// clicks used to race: the earlier save's conflict retry put back a tick the later one had removed.
// A save asked for while one is waiting adds nothing, since the waiting one reads the newer screen;
// and while any is open the checklist is not redrawn (renderClientPickerModels), so the screen it
// reads is still the one the person clicked, not the copy the save before it stored.
let pickerSaving = Promise.resolve();
let pickerSaveWaiting = false;
let pickerSavesOpen = 0;
// Whether a tick or a window changed since the last save read them. A reorder alone leaves the list
// as the router holds it: rebuilding it from this screen put back a model another window had removed.
let pickerSelectionsChanged = false;
function saveClientPickerModels(selectionsChanged = true) {
  if (selectionsChanged) pickerSelectionsChanged = true;
  if (pickerSaveWaiting) return pickerSaving;
  pickerSaveWaiting = true;
  pickerSavesOpen++;
  pickerSaving = pickerSaving.catch(() => {})
    .then(() => { pickerSaveWaiting = false; return saveClientPickerModelsNow(); })
    .finally(() => { pickerSavesOpen--; });
  return pickerSaving;
}
async function saveClientPickerModelsNow() {
  if (!currentConfig) return;
  // A reorder rides on this save only when one is waiting; otherwise the stored order stands, even
  // one another window saved since this screen last drew.
  const pendingOrder = pickerOrderPending;
  const selections = pickerSelectionsChanged ? clientPickerSelections() : null;
  pickerSelectionsChanged = false;
  const next = clone(await latestConfig());
  if (selections) applyPickerSelections(next, selections);
  if (pendingOrder) next.cli = { ...(next.cli || {}), extraModels: orderPickerEntries((next.cli && next.cli.extraModels) || [], pendingOrder) };
  // A conflict retry merges this save's ticks and windows field by field, as every save does, and
  // then puts the order back: an order is no field change, so the merge alone would drop it.
  const rebase = pendingOrder ? (fresh, replay) => {
    const merged = replay();
    merged.cli = { ...(merged.cli || {}), extraModels: orderPickerEntries((merged.cli && merged.cli.extraModels) || [], pendingOrder) };
    return merged;
  } : undefined;
  try {
    const out = await configRequest(next, rebase);
    currentConfig = next;
    if (pickerOrderPending === pendingOrder) pickerOrderPending = null;
    renderClientPickerOrder(pickerModeOn());
    // The override changes which window the router resolves; the rows read that map to decide
    // whether the catalogue is in effect, so read it again before the next redraw.
    pickerContextWindows = await api("/api/context-windows").catch(() => pickerContextWindows);
    // Everything the fields held, drafts included, is now the saved copy: there is nothing left to
    // carry over the next rebuild.
    pickerWindowDrafts.clear();
    // A tick or a window applies to the next session; an order only once the app is reopened.
    configSaved(out, t(pendingOrder ? "slots.pickerOrderSaved" : "slots.saved"));
  } catch (error) {
    // The order list goes back to what is saved rather than show an order the router never took.
    if (pickerOrderPending === pendingOrder) pickerOrderPending = null;
    renderClientPickerOrder(pickerModeOn());
    toast(t("common.saveFailed"), true, error.message);
  }
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
    const out = await configRequest(next);
    currentConfig = next;
    configSaved(out, t("common.saved"));
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
// Status names providers by the names people know (the one the user typed, a preset's name), which only
// the config carries; read it once here unless another page already has. The 5-second poll redraws with it.
if (!offline()) void api("/api/config").then((config) => { if (!currentConfig) { currentConfig = config; if (status) renderHealthProviders(); } }, () => { /* the status names stand */ });
// The open accounts tab follows the router (each refresher returns at once when its list is not shown).
setInterval(() => {
  if (document.visibilityState !== "visible" || !$("#modal-backdrop").hidden || !selectedProviderName) return;
  void refreshClaudeAccountPanel(selectedProviderName);
  void refreshChatgptAccountPanel(selectedProviderName);
  void refreshGoogleAccountPanel(selectedProviderName);
}, 10_000);

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
// Ripple Remote in the stores, each in the dashboard's language, as the README headers link them.
const REMOTE_STOREFRONT = { ko: "kr", en: "us", zh: "us", ja: "jp", es: "es", pt: "br" };
const REMOTE_PLAY_LANG = { ko: "ko", en: "en", zh: "zh-CN", ja: "ja", es: "es", pt: "pt-BR" };
/** Read when drawn, not at load: this block is also evaluated on its own by the phone tests. */
function remoteAppStoreUrl() { return `https://apps.apple.com/${REMOTE_STOREFRONT[CURRENT_LANG] || "us"}/app/id6823063731`; }
function remotePlayUrl() { return `https://play.google.com/store/apps/details?id=com.clauderipple.remote&hl=${REMOTE_PLAY_LANG[CURRENT_LANG] || "en"}`; }
function externalLink(href, cls, children) { return el("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, children); }
function phonePaired(data) { return Boolean(data && data.hostRunning && data.phones && data.phones.length); }
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
    el("div", { class: "remote-get" }, [
      externalLink(remoteAppStoreUrl(), "btn large remote-store", [download, t("phone.promo.appStore")]),
      externalLink(remotePlayUrl(), "btn large remote-store", [download.cloneNode(true), t("phone.promo.googlePlay")]),
    ]),
    el("p", { class: "remote-next", text: t(data.hostRunning ? "phone.promo.nextQr" : "phone.promo.nextHost") }),
  ]);
}
/** A phone is paired already: one quiet row for the next phone instead of the pitch. */
function remoteGetApp() {
  return section(null, [cell(t("phone.promo.compact"), [
    externalLink(remoteAppStoreUrl(), "btn secondary compact", [t("phone.promo.appStoreShort")]),
    externalLink(remotePlayUrl(), "btn secondary compact", [t("phone.promo.googlePlayShort")]),
  ])]);
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

/** The conflict row's body: the app and its own fix when we know it, else the unknown cause. */
function macConflictBody(c) {
  if (typeof c.name === "string" && c.name) {
    const app = t("mac.conflict.app", { app: c.name });
    const fixKey = `mac.conflict.fix.${c.app}`;
    return typeof c.app === "string" && hasI18nKey(fixKey) ? `${app} ${t(fixKey)}` : app;
  }
  return t("mac.conflict.unknown");
}

function macAwakeCard(a) {
  const why = macAwakeWhy(a);
  const state = a.applied
    ? macStateRow("on", t("mac.awake.on"), why.text, macFacts(a))
    : macStateRow(why.warn ? "warn" : "off", t("mac.awake.off"), why.text, macFacts(a));
  const modes = [{ value: "off", label: t("mac.mode.off") }, { value: "working", label: t("mac.mode.working") }, { value: "on", label: t("mac.mode.on") }];
  // Another app can write the same sleep setting (router awake.ts): it clears the bit when it stops,
  // so a closed lid sleeps. Only worth saying while we hold it; an older router's string is ignored.
  const conflict = a.conflict && typeof a.conflict === "object" && a.mode !== "off"
    ? macStateRow("warn", t("mac.conflict.title"), macConflictBody(a.conflict))
    : null;
  const rows = [
    state,
    conflict,
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
  // A retired source still identifies a saved route, including when its row is removed.
  if (selected && !claudeModels.some((model) => model.id === selected)) select.appendChild(selectOption(selected, selected));
  select.value = selected || claudeModels[0].id;
  return select;
}
function targetSelect(route) {
  const select = el("select", {});
  select.appendChild(selectOption("", t("slots.passthrough")));
  for (const group of groupedModels(currentConfig)) {
    const optgroup = el("optgroup", { label: providerName(group.name, group.provider) });
    for (const model of group.models) optgroup.appendChild(selectOption(JSON.stringify([group.name, model.id]), labelOf(model)));
    select.appendChild(optgroup);
  }
  const value = route ? JSON.stringify([route.provider, route.model]) : "";
  // Do not make an unavailable saved target look like passthrough; it must remain removable.
  if (route && !$all("option", select).some((option) => option.value === value)) select.appendChild(selectOption(value, `${route.provider} / ${route.model} (?)`));
  select.value = value;
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
  // Who answers, in its vendor's hue: Claude's own when the row passes through, else the provider picked.
  const dot = vendorDot("anthropic", { type: "anthropic" });
  function sync() {
    const selected = routeFromTarget(target.value);
    dot.style.color = selected ? providerHue(selected.provider, currentConfig.providers[selected.provider]) : providerHue("anthropic", { type: "anthropic" });
    // A row that passes through reads quieter, so the rows that send a model elsewhere stand out.
    row.classList.toggle("passthrough", !selected);
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
    el("div", { class: "map-col map-target" }, [el("span", { class: "map-label", text: t("slots.th.target") }), el("div", { class: "map-target-control" }, [dot, target])]),
    effortCell,
    el("div", { class: "map-remove" }, [remove]),
  );
  row._get = () => ({ id: source.value, route: routeFromTarget(target.value), effort: effort.disabled ? undefined : effort.value });
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
    // Compare against what the controls actually displayed, not implicit/defaulted config fields.
    slotsBaseline = readSlotRoutes();
    updateSlotSummary();
  } catch (error) {
    toast(t("common.loadFailed"), true, error.message);
  }
}
$("#slots-add").addEventListener("click", () => {
  if (!currentConfig) return;
  const row = slotRow(claudeModels[0].id, null);
  $("#slots-list").appendChild(row);
  updateSlotSummary();
  // The new row lands at the end of a long list: bring it into view and put the focus on its Claude model, so the press visibly did something.
  row.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  row.querySelector("select").focus({ preventScroll: true });
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
function applyPickerSelections(next, selections, preserveWindows = false) {
  const known = allKnownModelIds(next);
  // An entry no provider offers any more has no checkbox — the list is built from the providers —
  // so keeping it here left removed models in the app picker forever, twice over once the same id
  // had been written twice. Orphans go, the rest is deduplicated by model id, and the direct rules
  // that served only an orphan go with it. A prefix rule that is not a model id (the legacy gpt-
  // one) is not an orphan and stays.
  const currentExtras = (next.cli && next.cli.extraModels) || [];
  const orphans = new Set(currentExtras.filter((entry) => entry.model && !known.has(entry.model)).map((entry) => entry.model));
  // The app picker lists these in stored order, and that order is the operator's: an entry that
  // stays keeps its place and one ticked now goes after them. The rebuild used to follow the order
  // of `selections`, so every provider save moved that provider's models to the end.
  const stored = new Map();
  currentExtras.forEach((entry, index) => { if (!stored.has(entry.model)) stored.set(entry.model, index); });
  const place = (entry) => stored.has(entry.id) ? stored.get(entry.id) : currentExtras.length;
  const selected = selections.filter((entry) => entry.id && entry.provider && known.has(entry.id)).sort((a, b) => place(a) - place(b));
  const extras = new Map();
  const direct = new Map();
  for (const entry of selected) {
    // A provider form has no window editor; an explicit Clients-screen override wins its catalogue.
    const saved = preserveWindows && currentExtras.find((extra) => extra.model === entry.id);
    const contextWindow = saved && saved.contextWindow !== undefined ? saved.contextWindow : entry.contextWindow;
    extras.set(entry.id, { model: entry.id, name: entry.name || entry.id, ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}) });
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
/**
 * What a provider form's save leaves in the picker: every other provider's entries, and of its own
 * the ones the "show in picker" box speaks for. A provider already in the picker keeps the subset
 * the Clients screen chose, plus any model this save declares for the first time; ticking all of
 * them again put back the models the operator had taken out there. A provider that had none shown
 * — a new one, or the box just ticked — shows everything it declares, as before.
 */
function providerPickerSelections(config, providerName, saved, checkedModels, show) {
  const others = pickerSelectionsExcept(config, providerName);
  if (!show) return others;
  const shown = new Set(((config.cli && config.cli.extraModels) || []).map((entry) => entry.model));
  const declared = new Set(((saved && saved.models) || []).map((model) => typeof model === "string" ? model : model && model.id));
  const keepSubset = [...declared].some((id) => shown.has(id));
  const own = keepSubset ? checkedModels.filter((model) => shown.has(model.id) || !declared.has(model.id)) : checkedModels;
  return [...others, ...own.map((model) => ({ ...model, provider: providerName }))];
}
/**
 * `entries` (picker entries) with the ones `ids` names put into that order, among the places they
 * already hold. The rest — ticked since the order was read, or not in the order list at all, as a
 * Claude model the app lists itself — stay where they are.
 */
function orderPickerEntries(entries, ids) {
  const rank = new Map(ids.map((id, index) => [id, index]));
  const listed = entries.filter((entry) => rank.has(entry.model)).sort((a, b) => rank.get(a.model) - rank.get(b.model));
  let next = 0;
  return entries.map((entry) => rank.has(entry.model) ? listed[next++] : entry);
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
let slotsSaveAgain = false;
/** Last acknowledged controls, independent of currentConfig (other screens refresh that).
 * @type {Record<string, {provider: string, model: string, effort?: string} | null> | null}
 */
let slotsBaseline = null;
/** Snapshot the controls before any await; a change during GET/PUT belongs to the next save. */
function readSlotRoutes() {
  const entries = $all("#slots-list .map-row").map((row) => {
    const { id, route, effort } = row._get();
    return [id, route ? { ...route, ...(effort !== undefined ? { effort } : {}) } : null];
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error(t("slots.duplicate"));
  return Object.fromEntries(entries);
}
/** A changed row owns its provider/model/effort together; untouched rows and latest metadata survive.
 * Explicit removal wins over a remote edit. An edited row deleted remotely is recreated in full,
 * without resurrecting old metadata. Apply the same rule before PUT and after every 409.
 * @param {Object} fresh
 * @param {Record<string, Object | null>} before
 * @param {Record<string, Object | null>} after
 */
function mergeSlotRoutes(fresh, before, after) {
  const next = clone(fresh);
  next.routes = { ...(next.routes || {}) };
  const changed = new Set(modChanges(before, after).map((change) => change.path[0]));
  for (const id of changed) {
    const route = after[id];
    if (!route) { delete next.routes[id]; continue; }
    next.routes[id] = { ...next.routes[id], ...route };
    if (route.effort === undefined) delete next.routes[id].effort;
  }
  return next;
}
function slotsStatus(text, isError) {
  const box = $("#slots-status");
  box.textContent = text;
  box.classList.toggle("bad-text", Boolean(isError));
}
function scheduleSlotsSave() {
  if (!currentConfig || !slotsLoaded) return;
  clearTimeout(slotsSaveTimer);
  slotsStatus(t("slots.saving"));
  if (slotsSaving) { slotsSaveAgain = true; return; }
  slotsSaveTimer = setTimeout(() => void saveSlots(), 500);
}
async function saveSlots() {
  if (!currentConfig || !slotsBaseline) return;
  if (slotsSaving) { slotsSaveAgain = true; return; }
  clearTimeout(slotsSaveTimer);
  slotsSaveTimer = null;
  slotsSaving = true;
  try {
    const sent = readSlotRoutes();
    const before = slotsBaseline;
    const rebase = (fresh) => mergeSlotRoutes(fresh, before, sent);
    // A failed read must not fall back to stale settings, including on legacy routers.
    const next = rebase(await api("/api/config"));
    const out = await configRequest(next, rebase);
    currentConfig = next;
    slotsBaseline = sent;
    slotsStatus(out && out.warning ? out.warning : t("slots.saved"), Boolean(out && out.warning));
    configSaved(out);
    updateSlotSummary();
  } catch (error) {
    slotsStatus(`${t("common.saveFailed")} ${error.message}`, true);
  } finally {
    slotsSaving = false;
    if (slotsSaveAgain) { slotsSaveAgain = false; await saveSlots(); }
  }
}

// ---- Providers ----------------------------------------------------------------------

async function probeProvider(name, provider, onComplete) {
  probeStates.set(name, { pending: true });
  renderHealthProviders();
  try {
    const headers = provider.headers || {};
    const body = provider.type === "anthropic"
      ? { type: "anthropic", auth: provider.auth, ...(provider.auth === "api-key" && provider.apiKey ? { apiKey: provider.apiKey } : {}) }
      : provider.type === "google"
      ? { type: "google", auth: provider.auth, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}), ...(provider.url ? { url: provider.url } : {}) }
      : provider.type === "grok"
      ? { type: "grok", ...Object.fromEntries(["home", "cli", "url", "clientVersion"].filter((key) => provider[key]).map((key) => [key, provider[key]])) }
      : {
        type: provider.type,
        url: provider.url,
        headers,
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
 * Whether this provider is Ollama (the local daemon or the cloud endpoint).
 *
 * Ollama states a model's thinking levels and context length in its own `/api/show`, beside the
 * OpenAI-compatible surface, and a probe on that surface reads an unknown `reasoning_effort` as no
 * effort at all. An empty ladder is therefore what an unread Ollama model looks like, not a
 * decision (Discord report, 0.12.14).
 */
function isOllamaProvider(provider) {
  if (!provider) return false;
  if (provider.preset === "ollama") return true;
  const url = String(provider.url || "");
  return /^https?:\/\/(?:[^/]*\.)?ollama\.com(?::\d+)?(?:[/?#]|$)/i.test(url)
    || /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):11434(?:[/?#]|$)/i.test(url);
}

/**
 * Measure the models of one provider, in the background, and show the config the result settled.
 *
 * Only models missing a wire or a ladder are sent: one the operator set is their decision, and the
 * router will not overwrite it either, so measuring it again would spend requests to change nothing.
 * Ollama's empty ladder is the exception — see `isOllamaProvider`.
 */
async function startMeasurement(providerName, provider) {
  if (!provider || (provider.type !== "openai-compatible" && provider.type !== "anthropic-compatible")) return;
  const ollama = isOllamaProvider(provider);
  const models = modelsOf(provider)
    .filter((model) => !model.wire || !model.effortLevels || (ollama && Array.isArray(model.effortLevels) && model.effortLevels.length === 0))
    .map((model) => model.id);
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
    vendorDot(name, provider),
    el("span", { class: "provider-rail-copy" }, [
      el("strong", { text: providerName(name, provider) }),
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
  const visible = entries.filter(([name, provider]) => !query || name.toLowerCase().includes(query) || providerLabel(name, provider).toLowerCase().includes(query) || providerName(name, provider).toLowerCase().includes(query) || providerKind(name, provider).toLowerCase().includes(query));
  list.replaceChildren(...visible.map(([name, provider]) => providerRailItem(name, provider)));
  if (!entries.length) list.appendChild(el("div", { class: "provider-rail-empty", text: t("providers.empty") }));
  else if (!visible.length) list.appendChild(el("div", { class: "provider-rail-empty", text: t("providers.noSelection") }));
}

/**
 * Everywhere a config names this provider besides its own block. Removing the block alone leaves a
 * config the router refuses (a fallback or the search naming an unknown provider), so these are what
 * a removal also cleans up — shown first, so nothing goes quietly (B13).
 */
function providerUsages(config, name) {
  const routes = config.routes || {};
  // The picker list names a provider per extra model; ownership follows the same rule the removal
  // uses, so a model that routes elsewhere is not counted twice.
  const extraModels = ((config.cli && config.cli.extraModels) || []).filter((entry) => {
    const rule = (config.direct || []).filter((item) => entry.model.startsWith(item.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    const route = routes[entry.model];
    return (rule ? rule.provider : route ? route.provider : pickerOwner(config, entry.model)) === name;
  });
  return {
    routes: Object.entries(routes).filter(([, route]) => route && route.provider === name).map(([id]) => id),
    fallbacks: Object.entries(routes).flatMap(([id, route]) => (route && Array.isArray(route.fallbacks) ? route.fallbacks : []).filter((fallback) => fallback && fallback.provider === name).map((fallback) => ({ route: id, model: fallback.model }))),
    direct: (config.direct || []).filter((rule) => rule && rule.provider === name).length,
    picker: extraModels.length,
    search: Boolean(config.webSearch && config.webSearch.provider === name),
    classifier: classifierNames(config.autoModeClassifier, name),
  };
}
/** The usage line's extra clauses, each absent when the config does not name this provider there. */
function usageSuffix(usage, keys) {
  return (usage.search ? keys.search : "") + (usage.classifier ? keys.classifier : "");
}
async function removeProvider(name, provider) {
  const usages = providerUsages(currentConfig || {}, name);
  // What else goes with it is said before the confirm, never discovered afterwards.
  const extra = usages.fallbacks.length || usages.direct || usages.picker || usages.search || usages.classifier
    ? `\n\n${t("providers.removeExtra", { fallbacks: usages.fallbacks.length, direct: usages.direct, picker: usages.picker })}${usageSuffix(usages, { search: t("providers.usageSearch"), classifier: t("providers.usageClassifier") })}`
    : "";
  if (!confirm(`${t("providers.removeConfirm", { name: providerName(name, provider) })}${extra}`)) return;
  const next = clone(await latestConfig());
  // Resolve ownership before deleting declarations or the disambiguating direct rules.
  if (next.cli) next.cli.extraModels = (next.cli.extraModels || []).filter((entry) => {
    const rule = (next.direct || []).filter((rule) => entry.model.startsWith(rule.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
    const route = (next.routes || {})[entry.model];
    return (rule ? rule.provider : route ? route.provider : pickerOwner(next, entry.model)) !== name;
  });
  delete next.providers[name];
  // Routes and their fallbacks: a route that pointed here goes, and no other route keeps a fallback
  // to a provider that no longer exists.
  next.routes = Object.fromEntries(Object.entries(next.routes || {}).flatMap(([id, route]) => {
    if (route.provider === name) return [];
    const fallbacks = (route.fallbacks || []).filter((fallback) => fallback.provider !== name);
    const cleaned = { ...route };
    if (route.fallbacks !== undefined) {
      if (fallbacks.length) cleaned.fallbacks = fallbacks;
      else delete cleaned.fallbacks;
    }
    return [[id, cleaned]];
  }));
  next.direct = (next.direct || []).filter((rule) => rule.provider !== name);
  // The search and the Auto-mode classifier name a provider of their own; left behind, they are the
  // same unknown-provider error as a fallback. The classifier's two stages are cleared one by one, so
  // a first stage on another provider outlives the removal of the rest's, and the reverse.
  if (next.webSearch && next.webSearch.provider === name) delete next.webSearch;
  if (classifierNames(next.autoModeClassifier, name)) {
    const kept = classifierWithout(next.autoModeClassifier, name);
    if (kept) next.autoModeClassifier = kept;
    else delete next.autoModeClassifier;
  }
  try {
    const out = await configRequest(next);
    currentConfig = next;
    selectedProviderName = Object.keys(next.providers)[0] || null;
    providerDetailTab = "overview";
    slotsLoaded = false;
    clientsLoaded = false;
    closeProviderDetail();
    renderProviderWorkspace();
    configSaved(out, t("common.saved"));
  } catch (error) {
    // The router refused (another change landed first): say so and show the config it holds, rather
    // than leaving the form's copy on screen as if the removal had happened.
    toast(t("common.saveFailed"), true, error.message);
    providersLoaded = false;
    void loadProviders();
  }
}

function providerTabs(name, provider) {
  const tabs = [{ id: "overview", label: t("providers.overview") }];
  if ((provider.type === "anthropic" && provider.auth === "claude-code") || provider.type === "chatgpt" || (provider.type === "google" && provider.auth === "antigravity") || isKeyProvider(provider)) tabs.push({ id: "accounts", label: t("providers.accounts") });
  tabs.push({ id: "models", label: t("providers.modelsTab") });
  return el("div", { class: "provider-tabs", role: "tablist" }, tabs.map((tab) => {
    const button = el("button", { class: providerDetailTab === tab.id ? "active" : "", type: "button", role: "tab", id: `provider-tab-${tab.id}`, "aria-controls": "provider-tab-panel", "aria-selected": String(providerDetailTab === tab.id), text: tab.label });
    button.addEventListener("click", () => { providerDetailTab = tab.id; renderProviderDetail(); });
    return button;
  }));
}

/** One line of the overview's facts: a quiet name on the left, what it says on the right. */
function providerFact(label, children) {
  return el("div", { class: "provider-fact" }, [el("span", { class: "provider-fact-k", text: label }), el("div", { class: "provider-fact-v" }, children.filter(Boolean))]);
}

/**
 * The overview reads like the provider's block on the Status screen: one card of facts (the connection
 * verdict and what to do about it, where the config names the provider, its models), then its usage
 * gauges as Status draws them. A provider the limits read does not list keeps its one-line usage figure.
 */
function providerOverview(name, provider) {
  const state = stateFor(name);
  const live = status && status.providers && status.providers[name];
  const models = modelsOf(provider);
  const measuring = measureStates.get(name);
  const running = measuring && measuring.state === "running";
  // Where this provider is named besides its own block: routes, fallbacks, direct rules, the picker
  // and the two single-provider settings. Seeing them before pressing remove is the point (B13).
  const usages = providerUsages(currentConfig || {}, name);
  const used = usages.routes.length || usages.fallbacks.length || usages.direct || usages.picker || usages.search || usages.classifier;
  const quota = quotaLine(name);
  const gauges = providerGauges(name);
  const facts = el("div", { class: "group provider-facts" }, [
    // The kind is already under the page title; this line is only the verdict and what to do about it.
    providerFact(t("health.connection"), [
      providerState(name, provider),
      state && !state.ok && state.error ? el("span", { class: "cell-sub bad-text", text: shortError(state.error), title: state.error }) : null,
      live && live.needsLogin && provider.type === "chatgpt" ? el("div", { class: "cell-actions" }, [chatgptLoginButton(renderProviderDetail)]) : null,
    ]),
    used ? providerFact(t("providers.usedBy"), [
      el("span", { text: t("providers.usageCounts", { routes: usages.routes.length, fallbacks: usages.fallbacks.length, direct: usages.direct, picker: usages.picker }) + usageSuffix(usages, { search: t("providers.usageSearch"), classifier: t("providers.usageClassifier") }) }),
      usages.fallbacks.length ? el("span", { class: "cell-sub mono", text: t("providers.usageFallbacks", { list: usages.fallbacks.map((fallback) => `${fallback.route} → ${fallback.model}`).join(", ") }) }) : null,
    ]) : null,
    // Names only, as one line: the Models tab is where each one is listed and edited.
    providerFact(t("providers.selectedModels"), [
      el("span", { class: models.length ? "" : "cell-sub", text: models.length ? models.map(labelOf).join(", ") : t("providers.noModels") }),
      running ? el("span", { class: "cell-sub", text: t("measure.running", { done: measuring.done, total: measuring.total }) }) : null,
      running ? el("span", { class: "cell-sub", text: t("measure.help") }) : null,
    ]),
    !gauges && quota ? providerFact(t("providers.usage"), [el("span", { text: quota })]) : null,
  ]);
  return el("div", { class: "provider-panel" }, [facts, providerUsageSection(name)]);
}
/** The provider's entry in the limits read when it has figures to draw, else null. */
function providerGauges(name) {
  const limits = providerLimits(name);
  return limits && limits.accounts.some((account) => (account.windows || []).length) ? limits : null;
}
/** The overview's usage: Status's own account rows for this provider, or an empty placeholder until the read has figures. */
function providerUsageSection(name) {
  const gauges = providerGauges(name);
  if (!gauges) return el("div", { id: "provider-usage-section", hidden: "" });
  const now = Date.now();
  const credentials = (status && status.credentials && status.credentials[name]) || [];
  return el("section", { class: "section", id: "provider-usage-section" }, [
    el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.usage") })]),
    el("div", { class: "group provider-limits provider-usage" }, gauges.accounts.map((account) =>
      limitsAccountRow(gauges, account, now, account.id === undefined ? undefined : credentials.find((c) => c.id === account.id)))),
  ]);
}
/** A limits read landed: the open overview's gauges follow it, as Status's do, and nothing else on the page is redrawn. */
function refreshProviderUsage() {
  const shown = $("#provider-usage-section");
  if (!shown || !selectedProviderName || providerDetailTab !== "overview") return;
  // A provider that had no figures when the overview was drawn keeps its one-line usage figure there until the page is redrawn.
  if (shown.hidden && quotaLine(selectedProviderName)) return;
  shown.replaceWith(providerUsageSection(selectedProviderName));
}

function providerModelsPanel(name, provider) {
  const models = modelsOf(provider);
  const edit = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit"), onclick: () => openProviderForm({ name, provider }) });
  return el("div", { class: "provider-panel" }, [
    section(t("providers.selectedModels"), models.length
      ? models.map((model) => {
          const tag = modelEffortTag(model);
          const note = modelWindowNote(model);
          return cell(labelOf(model), tag ? el("span", { class: `model-effort-tag ${model.effortLevels.length ? "has-effort" : "no-effort"}`, text: tag }) : null, [
            el("span", { class: "cell-sub mono", text: model.id }),
            note ? el("span", { class: "cell-sub warn-text", text: note }) : null,
          ], "provider-model-row");
        })
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
    const out = await configRequest(next);
    currentConfig = next;
    slotsLoaded = false;
    clientsLoaded = false;
    renderProviderWorkspace();
    configSaved(out, t("providers.rotationSaved"));
  } catch (error) {
    control.checked = !enabled;
    message.textContent = "";
    toast(t("common.saveFailed"), true, error.message);
  } finally { control.disabled = false; }
}

/** The router names the current login and an unnamed added account in English; a label the user set is shown as is. */
function claudeAccountLabel(account) {
  if (account.id === "current") return t("providers.anthropicCurrent");
  return account.label === "Claude account" ? t("providers.claudeAccountDefault") : account.label;
}

/** "5h 14% · weekly 10%" under a Claude account, or nothing while its usage is unknown. */
function claudeQuotaNode(account) {
  const text = chatgptQuotaText(account && account.quota);
  return text ? quotaMeters([account.quota.rate_limits.primary, account.quota.rate_limits.secondary]) : null;
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

/**
 * The same pool controls for stored logins and API keys; the external Claude login only pauses.
 * @param {{preferred?: boolean, paused?: boolean, state?: string, cooldownSeconds?: number, external?: boolean}} account
 * @param {(change: {preferred?: boolean, paused?: boolean, clearCooldown?: true}) => Promise<unknown>} patch
 */
function accountPoolActions(account, patch) {
  const actions = [];
  const add = (text, change) => {
    const button = el("button", { class: "btn secondary compact", type: "button", text });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await patch(change); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
      finally { button.disabled = false; }
    });
    actions.push(button);
  };
  if (!account.external) add(t(account.preferred ? "providers.preferClear" : "providers.preferAction"), { preferred: !account.preferred });
  add(t(account.paused ? "providers.chatgptResume" : "providers.chatgptPause"), { paused: !account.paused });
  if (!account.external && (account.state === "cooling" || account.cooldownSeconds > 0)) add(t("providers.chatgptClearCooldown"), { clearCooldown: true });
  return actions;
}

/**
 * A resting Antigravity quota group as the limits row names it, with the host it rests on: the key is
 * `group@host` (`3p@daily-cloudcode-pa.googleapis.com` → "3P daily"), because each host counts its own.
 */
function quotaGroupLabel(key) {
  const [group, host] = key.split("@");
  const name = group === "3p" ? "3P" : group === "gemini" ? "Gemini" : group;
  if (!host) return name;
  return `${name} ${/^daily-/.test(host) ? "daily" : host === "cloudcode-pa.googleapis.com" ? "prod" : host}`;
}

/**
 * Runtime use is independent of first place, pauses and cooldowns. A resting quota group
 * (`quotaCooldowns`, Antigravity) is shown beside the account's own state: the account still answers
 * the other group.
 */
function accountPoolBadges(account) {
  return [
    account.preferred ? el("span", { class: "badge first", text: t("providers.preferBadge") }) : null,
    chatgptStateBadge(account),
    ...Object.entries(account.quotaCooldowns || {}).map(([group, seconds]) =>
      el("span", { class: "badge warn", text: `${quotaGroupLabel(group)} · ${t("pool.coolingFor", { duration: durationText(seconds) })}` })),
    account.inUse && account.state && account.state !== "ready" ? el("span", { class: "badge ok in-use", text: t("providers.chatgptInUse") }) : null,
  ];
}

function renderClaudeAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  // A stored account the router recognises as the current login (left over from an earlier setup)
  // is the same person's one account: it gets no row of its own and is not counted.
  const all = Array.isArray(data.accounts) ? data.accounts : [];
  const duplicates = data.current ? all.filter((account) => account.sameAsCurrent) : [];
  // Rows follow the order the router tries them in: the preferred account, else the current login, first.
  const stored = all.filter((account) => !duplicates.includes(account));
  const preferredIndex = stored.findIndex((account) => account.preferred);
  if (preferredIndex > 0) stored.unshift(...stored.splice(preferredIndex, 1));
  const leader = preferredIndex >= 0 ? stored[0].id : data.current ? "current" : stored[0] && stored[0].id;
  const choosable = (data.current ? 1 : 0) + stored.length > 1;
  const rows = [];
  let removeOld = null;
  if (duplicates.length) {
    removeOld = el("button", { class: "btn secondary compact", type: "button", text: t("providers.anthropicRemoveOld") });
    removeOld.addEventListener("click", async () => {
      if (!confirm(t("providers.anthropicRemoveOldConfirm"))) return;
      removeOld.disabled = true;
      try {
        for (const account of duplicates) await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
        await refreshClaudeAccountPanel(name);
      } catch (error) { removeOld.disabled = false; toast(t("common.actionFailed"), true, error.message); }
    });
  }
  const currentActions = [data.current && choosable && leader !== "current" && !data.current.paused ? claudePreferButton(name, null, false) : null,
    ...(data.current ? accountPoolActions(data.current, async (change) => {
      await api("/api/claude-accounts/current", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      await refreshClaudeAccountPanel(name);
    }) : []), removeOld].filter(Boolean);
  const currentRow = data.current ? el("article", { class: "cell account-card current" }, [
    el("div", { class: "cell-text account-card-copy" }, [
      el("strong", { text: t("providers.anthropicCurrentLogin") }), data.current.email ? el("span", { class: "small", text: data.current.email }) : null,
      el("span", { class: "small", text: anthropicSourceText(data.current.source) }), claudeQuotaNode(data.current), hint(t("providers.currentAccountHelp")),
      duplicates.length ? hint(t("providers.anthropicOldSignIn")) : null,
      currentActions.length ? el("div", { class: "account-card-actions" }, currentActions) : null,
    ]),
    el("div", { class: "account-card-badges" }, accountPoolBadges({ ...data.current, preferred: choosable && leader === "current" && !data.current.paused })),
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
      if (!confirm(t("providers.anthropicRemoveConfirm", { name: claudeAccountLabel(account) }))) return;
      try { await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshClaudeAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    const actions = [...accountPoolActions(account, async (change) => {
      await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      await refreshClaudeAccountPanel(name);
    }), rename, remove];
    if (unavailable) {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => openClaudeAccountConsent(name));
      actions.unshift(reauth);
    }
    rows.push(el("article", { class: "cell account-card" }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: claudeAccountLabel(account) }), account.email && account.email !== account.label ? el("span", { class: "small", text: account.email }) : null, claudeQuotaNode(account),
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, accountPoolBadges({ ...account, state: account.state || (unavailable ? "needs-login" : "ready"), preferred: account.preferred || (choosable && account.id === leader) })),
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

/**
 * The answer each account list was last drawn from. The open list is fetched again on a timer, so a
 * state the router learns later (Google asking for verification, a cooldown, a needs-login) shows
 * without reopening the tab; an unchanged answer is not redrawn, so a button under the pointer stays.
 */
const accountRowsDrawn = new WeakMap();
function drawAccountRows(target, data, draw) {
  const json = JSON.stringify(data);
  if (accountRowsDrawn.get(target) === json) return;
  accountRowsDrawn.set(target, json);
  draw();
}
function accountRowsFailed(target, error) {
  accountRowsDrawn.delete(target);
  target.replaceChildren(el("div", { class: "bad-text small", text: error.message }));
}

async function refreshClaudeAccountPanel(name) {
  const target = $("#claude-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { const data = await api("/api/claude-accounts"); drawAccountRows(target, data, () => renderClaudeAccountRows(target, data, name, generation)); }
  catch (error) { if (generation === providerDetailGeneration) accountRowsFailed(target, error); }
}

function anthropicAccountsPanel(name, provider) {
  const rotation = el("input", { type: "checkbox", checked: Boolean(provider.accountPool) });
  const rotationMessage = el("span", { class: "small" });
  rotation.addEventListener("change", () => void saveAnthropicRotation(name, provider, rotation.checked, rotation, rotationMessage));
  const add = el("button", { class: "cell-button account-add", type: "button", text: t("providers.addClaudeAccount") });
  add.addEventListener("click", () => openClaudeAccountConsent(name));
  rotation.setAttribute("role", "switch");
  rotation.setAttribute("aria-label", t("providers.anthropicPool"));
  const rows = el("div", { id: "claude-account-rows", class: "account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  // The rotation switch first (it decides whether added accounts are used at all), then the
  // accounts with "Add" as the last row of their card. Removing every added account is destructive,
  // so it stands at the bottom beside removing the provider (anthropicLogoutAllButton).
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "group" }, [cell(t("providers.anthropicPool"), el("label", { class: "switch" }, [rotation, el("span")]), [t("providers.accountPoolSubtitle"), rotationMessage])]),
      !provider.accountPool ? el("div", { class: "group-footer notice" }, [el("strong", { text: t("providers.rotationOff") }), el("span", { text: t("providers.rotationRequired") })]) : null,
    ]),
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.accountPoolTitle") }), el("span", { id: "claude-account-count", class: "small", text: t("providers.accountCount", { count: 0 }) })]),
      el("div", { class: "group account-group" }, [rows, add]),
      el("p", { id: "claude-account-prefer", class: "group-footer", text: t("providers.preferHelp"), hidden: "" }),
      el("p", { class: "group-footer", text: t("providers.accountCountHelp") }),
      // Said once for every account added here, rather than under each of them.
      el("p", { class: "group-footer", text: t("providers.addedAccountHelp") }),
    ]),
  ]);
  queueMicrotask(() => void refreshClaudeAccountPanel(name));
  return panel;
}
/** Signs every added Claude account out; the current Claude login is not one of them. */
function anthropicLogoutAllButton(name) {
  const removeAll = el("button", { class: "cell-button destructive", type: "button", text: t("providers.anthropicLogoutAll") });
  removeAll.addEventListener("click", async () => {
    if (!confirm(t("providers.anthropicLogoutAllConfirm"))) return;
    try { await api("/api/claude-logout", { method: "POST" }); await refreshClaudeAccountPanel(name); }
    catch (error) { toast(t("common.actionFailed"), true, error.message); }
  });
  return removeAll;
}

/** "5h 42%", "weekly 100% · resets 14:05" — the reset only matters once a window is full. */
function chatgptQuotaText(quota) {
  const limits = quota && quota.rate_limits;
  if (!limits) return "";
  return quotaWindowsText([limits.primary, limits.secondary]);
}
/** The same line for any list of usage windows (`/api/limits` windows included). */
function quotaWindowsText(windows) {
  return (windows || []).filter((w) => w && typeof w.used_percent === "number").map((w) => {
    const line = t("quota.line", { window: quotaWindowName(w), percent: Math.round(w.used_percent) }).trim();
    const reset = quotaFullReset(w);
    return reset ? `${line} · ${reset}` : line;
  }).join(" · ");
}
/** A usage window's name in a quota line: "5시간", "주간", "월간", else its hours. */
function quotaWindowName(w) {
  const minutes = w.window_minutes;
  if (!minutes) return "";
  if (minutes >= 28 * 24 * 60) return t("quota.windowMonth");
  if (minutes >= 7 * 24 * 60) return t("quota.windowWeek");
  if (minutes === 300) return t("quota.window5h");
  return t("quota.windowHours", { hours: Math.round(minutes / 60) });
}
/** When a full window resets ("resets 11/12 14:05"); nothing for a window that still has room, where nobody acts on it. */
function quotaFullReset(w) {
  if (w.used_percent < 100) return "";
  const at = typeof w.reset_after_seconds === "number" ? Date.now() + w.reset_after_seconds * 1000 : typeof w.reset_at === "number" ? w.reset_at * 1000 : null;
  return at ? t("quota.resetAt", { time: new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }) : "";
}
/**
 * An account's usage on its row in the accounts list: the windows of its quota line, each as a name, a
 * thin meter and its share, amber from 80% and red from 95% as on Status; a full window keeps its reset.
 * The whole line is the group's accessible name. Nothing when no window has a share.
 */
function quotaMeters(windows) {
  const shown = (windows || []).filter((w) => w && typeof w.used_percent === "number");
  if (!shown.length) return null;
  const text = quotaWindowsText(shown);
  return el("div", { class: "account-quota account-meters", role: "img", "aria-label": text, title: text }, shown.map((w) => {
    const percent = Math.round(w.used_percent);
    const fill = el("span", { class: "meter-fill" });
    fill.style.width = `${Math.max(0, Math.min(100, w.used_percent))}%`;
    const reset = quotaFullReset(w);
    return el("span", { class: `account-meter${percent >= 95 ? " tone-bad" : percent >= 80 ? " tone-warn" : ""}`, "aria-hidden": "true" }, [
      el("span", { class: "account-meter-name", text: quotaWindowName(w) }),
      el("span", { class: "meter" }, [fill]),
      el("span", { class: "account-meter-figure", text: `${percent}%` }),
      reset ? el("span", { class: "account-meter-reset", text: reset }) : null,
    ]);
  }));
}

/** A wait people read at a glance: "1시간 29분", "12분", "40초". */
function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s >= 3600) return t("time.hoursMinutes", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  if (s >= 60) return t("time.minutes", { m: Math.ceil(s / 60) });
  return t("time.seconds", { s });
}

function chatgptStateBadge(account) {
  if (account.paused || account.state === "paused") return el("span", { class: "badge", text: t("providers.chatgptPaused") });
  if (account.state === "needs-login" || account.state === "quarantined") return el("span", { class: "badge bad", text: t("providers.anthropicReauth") });
  if (account.state === "needs-verification") return el("span", { class: "badge warn", text: t("providers.googleVerifyNeeded") });
  if (account.state === "cooling") return el("span", { class: "badge warn", text: t("pool.coolingFor", { duration: durationText(account.cooldownSeconds) }) });
  return el("span", { class: account.inUse ? "badge ok in-use" : "badge ok", text: account.inUse ? t("providers.chatgptInUse") : t("providers.chatgptStandby") });
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
    if (!own && (account.state === "cooling" || account.cooldownSeconds > 0)) {
      const now = el("button", { class: "btn secondary compact", type: "button", text: t("providers.chatgptClearCooldown") });
      now.addEventListener("click", () => void patchChatgptAccount(name, account.id, { clearCooldown: true }));
      actions.push(now);
    }
    if (own) {
      actions.push(...accountPoolActions(account, (change) => patchChatgptAccount(name, account.id, change)));
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
      actions.push(rename, remove);
    }
    const quota = chatgptQuotaText(account.quota);
    const detail = [account.email && account.email !== account.label ? account.email : null, account.planType || null].filter(Boolean).join(" · ");
    // How an account added here is kept is said once under the list (chatgptAccountsPanel); a row says only what is its own.
    const help = account.state === "needs-login" || account.state === "quarantined" ? t("providers.chatgptReauthHelp") : own ? "" : t("providers.chatgptCodexHelp");
    return el("article", { class: `cell account-card${account.inUse ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }),
        detail ? el("span", { class: "small", text: detail }) : null,
        quota ? quotaMeters([account.quota.rate_limits.primary, account.quota.rate_limits.secondary]) : null,
        help ? hint(help) : null,
        actions.length ? el("div", { class: "account-card-actions" }, actions) : null,
      ]),
      el("div", { class: "account-card-badges" }, accountPoolBadges(account)),
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
    actions.push(...accountPoolActions(account, (change) => patchGoogleAccount(name, account.id, change)));
    // The account answers while a quota group rests (`quotaCooldowns`), so the shared actions show no
    // clear button for it; this one clears all of the account's resting groups at once. A failed
    // request leaves the row as it was, so the button comes back for another try.
    const resting = Object.keys(account.quotaCooldowns || {});
    if (resting.length && account.state !== "cooling" && !(account.cooldownSeconds > 0)) {
      const clear = el("button", { class: "btn secondary compact", type: "button", text: `${resting.map(quotaGroupLabel).join(", ")} · ${t("providers.chatgptClearCooldown")}` });
      clear.addEventListener("click", async () => {
        clear.disabled = true;
        try { await patchGoogleAccount(name, account.id, { clearCooldown: true }); }
        finally { clear.disabled = false; }
      });
      actions.push(clear);
    }
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
    actions.push(rename, remove);
    const detail = [account.email && account.email !== account.label ? account.email : null, account.projectId ? t("providers.googleProject", { id: account.projectId }) : null].filter(Boolean).join(" · ");
    return el("article", { class: `cell account-card${account.inUse ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }),
        detail ? el("span", { class: "small", text: detail }) : null,
        // How an account is kept is said once under the list (googleAccountsPanel); a row says only what it needs.
        account.state === "needs-login" || account.state === "quarantined" ? hint(t("providers.chatgptReauthHelp")) : account.state === "needs-verification" ? hint(t("providers.googleVerifyHelp")) : null,
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, accountPoolBadges(account)),
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
  try { const data = await api(`/api/google-accounts?provider=${encodeURIComponent(name)}`); drawAccountRows(target, data, () => renderGoogleAccountRows(target, data, name, generation)); }
  catch (error) { if (generation === providerDetailGeneration) accountRowsFailed(target, error); }
}

function googleAccountsPanel(name) {
  const add = el("button", { class: "cell-button account-add", type: "button", text: t("providers.addGoogleAccount") });
  add.disabled = googleLoginBusy;
  add.addEventListener("click", () => void startGoogleLogin(() => { renderProviderDetail(); void refreshGoogleAccountPanel(name); }));
  const rows = el("div", { id: "google-account-rows", class: "account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.googleAccountsTitle") }), el("span", { id: "google-account-count", class: "small", text: t("providers.chatgptAccountCount", { count: 0 }) })]),
      el("div", { class: "group account-group" }, [rows, add]),
      googleLoginBusy ? el("p", { class: "group-footer", text: t("providers.googleLoginWaiting") }) : null,
      el("div", { class: "group-footer notice warn" }, [el("strong", { text: t("providers.googleWarningShort") })]),
      el("p", { class: "group-footer", text: t("providers.googleAccountsSubtitle") }),
      el("p", { class: "group-footer", text: t("providers.googleOwnHelp") }),
    ]),
  ]);
  queueMicrotask(() => void refreshGoogleAccountPanel(name));
  return panel;
}

async function refreshChatgptAccountPanel(name) {
  const target = $("#chatgpt-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { const data = await api(`/api/chatgpt-accounts?provider=${encodeURIComponent(name)}`); drawAccountRows(target, data, () => renderChatgptAccountRows(target, data, name, generation)); }
  catch (error) { if (generation === providerDetailGeneration) accountRowsFailed(target, error); }
}

function chatgptAccountsPanel(name) {
  const add = el("button", { class: "cell-button account-add", type: "button", text: t("providers.addChatgptAccount") });
  add.disabled = chatgptLoginBusy;
  const waiting = el("p", { class: "group-footer", text: chatgptLoginBusy ? t("providers.chatgptAddWaiting") : "" });
  waiting.hidden = !chatgptLoginBusy;
  add.addEventListener("click", () => void startChatgptLogin(() => { renderProviderDetail(); void refreshChatgptAccountPanel(name); }, true));
  const rows = el("div", { id: "chatgpt-account-rows", class: "account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.chatgptAccountsTitle") }), el("span", { id: "chatgpt-account-count", class: "small", text: t("providers.chatgptAccountCount", { count: 0 }) })]),
      el("div", { class: "group account-group" }, [rows, add]),
      waiting,
      el("p", { class: "group-footer", text: t("providers.chatgptAccountsSubtitle") }),
      el("p", { class: "group-footer", text: t("providers.chatgptOwnHelp") }),
    ]),
  ]);
  queueMicrotask(() => void refreshChatgptAccountPanel(name));
  return panel;
}

// ---- API-key accounts (openai-compatible / anthropic-compatible) ---------------------------------
//
// An unnamed key without flags lives in `headers` alone. Named/flagged keys and pools retain
// `credentials`, with `headers` equal to the first for probing, model discovery and usage readers.

/** The inline add/edit form that is open: `{ provider, id }`, `id` null while adding. */
let keyForm = null;
/** The last `/api/limits` answer, for the per-key usage line. */
let keyLimits = null;

function isKeyProvider(provider) { return Boolean(provider) && (provider.type === "openai-compatible" || provider.type === "anthropic-compatible"); }
function isKeyHeader(header) { const lower = header.toLowerCase(); return lower === "authorization" || lower === "x-api-key"; }
/** The header a provider takes its key in, decided the way openProviderForm decides it. */
function keyHeaderKind(provider) {
  const preset = provider.preset && presetById(provider.preset);
  if (preset) return preset.authHeader === "authorization-bearer" ? "authorization-bearer" : "x-api-key";
  return provider.type === "openai-compatible" || Object.keys(provider.headers || {}).some((key) => key.toLowerCase() === "authorization") ? "authorization-bearer" : "x-api-key";
}
function normalizeKey(value) { return String(value || "").replace(/^\s*bearer\s+/i, "").replace(/\s+/g, ""); }
function keyOfHeaders(headers) {
  const entries = Object.entries(headers || {});
  const found = entries.find(([header]) => header.toLowerCase() === "authorization") || entries.find(([header]) => header.toLowerCase() === "x-api-key");
  return found ? normalizeKey(found[1]) : "";
}
/** A key's header set: the provider's auth header plus the vendor extras of `base`. */
function headersForKey(provider, key, base) {
  const extras = Object.fromEntries(Object.entries(base || {}).filter(([header]) => !isKeyHeader(header)));
  return keyHeaderKind(provider) === "authorization-bearer" ? { ...extras, authorization: `Bearer ${key}` } : { ...extras, "x-api-key": key };
}
/** Never the whole key: its first and last four characters, or nothing of a key too short to cut. */
function maskKey(key) { return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…"; }
function keyPool(provider) {
  if (Array.isArray(provider.credentials) && provider.credentials.length) return provider.credentials;
  return provider.headers ? [{ id: "default", headers: provider.headers }] : [];
}
/** Keep a single key's identity when it has a label or explicit pool flags. */
function writeKeyPool(provider, pool) {
  if (pool.length > 1 || (pool[0] && (pool[0].label || pool[0].preferred !== undefined || pool[0].paused !== undefined))) {
    provider.credentials = pool;
    provider.headers = { ...pool[0].headers };
    return;
  }
  delete provider.credentials;
  if (pool[0]) provider.headers = { ...pool[0].headers };
  else delete provider.headers;
}
/** A key left unnamed is called by its place in the list, in the language on screen; no name is saved for it. */
function keyLabel(credential, index) { return credential.label || t("providers.keyDefaultLabel", { n: index + 1 }); }
/** "k" and six random base36 characters; never derived from the key. */
function newKeyId(pool) {
  for (;;) {
    const id = `k${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => (byte % 36).toString(36)).join("")}`;
    if (!pool.some((credential) => credential.id === id)) return id;
  }
}

function keyStateBadge(name, credential, single) {
  if (credential.paused) return el("span", { class: "badge", text: t("providers.chatgptPaused") });
  const entry = ((status && status.credentials && status.credentials[name]) || []).find((item) => item.id === credential.id);
  if (entry) {
    if (entry.state === "quarantined") return el("span", { class: "badge bad", text: t("providers.keyStateRejected") });
    if (entry.state === "cooling") return el("span", { class: "badge warn", text: t("providers.keyStateCooling", { minutes: Math.max(1, Math.ceil((entry.cooldownSeconds || 0) / 60)) }) });
    return el("span", { class: "badge ok", text: t("providers.keyStateReady") });
  }
  if (!single) return null;
  const verdict = providerConnection(name);
  return el("span", { class: `badge ${verdict.level}`, text: verdict.level === "ok" ? t("providers.keyStateReady") : verdict.text });
}

function keyUsageText(name, index) {
  const windows = keyUsageWindows(name, index);
  return windows ? quotaWindowsText(windows) : "";
}
/** The key's usage windows in the last limits read, by its place in the pool; null when the read has none for it. */
function keyUsageWindows(name, index) {
  const entry = ((keyLimits && keyLimits.providers) || []).find((item) => item.provider === name);
  const account = entry && (entry.accounts || []).find((item) => item.account === index);
  return account ? account.windows : null;
}

async function saveKeyPool(next) {
  try {
    const out = await configRequest(next);
    currentConfig = next;
    keyForm = null;
    renderProviderWorkspace();
    configSaved(out, t("common.saved"));
    void refreshHealth();
    return true;
  } catch (error) {
    toast(t("common.saveFailed"), true, error.message);
    return false;
  }
}

/** Pool flags are saved together so first place is unique within this provider. */
async function patchKeyAccount(name, id, change) {
  if (change.clearCooldown) {
    await api("/api/credentials/clear-cooldown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: name, id }) });
    await refreshKeyAccountPanel(name);
    return;
  }
  const next = clone(await latestConfig());
  const provider = next.providers[name];
  if (!provider) throw new Error(t("common.loadFailed"));
  const pool = clone(keyPool(provider));
  const entry = pool.find((credential) => credential.id === id);
  if (!entry) throw new Error(t("common.loadFailed"));
  if (change.preferred) for (const credential of pool) credential.preferred = false;
  Object.assign(entry, change);
  writeKeyPool(provider, pool);
  await saveKeyPool(next);
}

/** Adds a key (`id` null) or changes one's label and key; an empty key field keeps the key. */
async function saveKeyAccount(name, id, labelValue, keyValue, button) {
  const key = normalizeKey(keyValue);
  if (id === null && !key) { toast(t("providers.keyRequired"), true); return; }
  button.disabled = true;
  const next = clone(await latestConfig());
  const target = next.providers[name];
  if (!target) { button.disabled = false; return; }
  const pool = clone(keyPool(target));
  const index = id === null ? -1 : pool.findIndex((credential) => credential.id === id);
  if (id !== null && index < 0) { button.disabled = false; return; }
  if (key && pool.some((credential, at) => at !== index && keyOfHeaders(credential.headers) === key)) {
    toast(t("providers.keyDuplicate"), true);
    button.disabled = false;
    return;
  }
  if (id === null) {
    // The key that was there becomes the first entry under the id "default", so its health history stays.
    const label = labelValue.trim();
    pool.push({ id: newKeyId(pool), ...(label ? { label } : {}), headers: headersForKey(target, key, pool[0] && pool[0].headers) });
  } else {
    const entry = pool[index];
    if (labelValue !== null) {
      const label = labelValue.trim();
      if (label) entry.label = label;
      else delete entry.label;
    }
    if (key) entry.headers = headersForKey(target, key, entry.headers);
  }
  writeKeyPool(target, pool);
  if (!(await saveKeyPool(next))) button.disabled = false;
}

async function removeKeyAccount(name, id, label) {
  if (!confirm(t("providers.keyRemoveConfirm", { label }))) return;
  const next = clone(await latestConfig());
  const target = next.providers[name];
  if (!target) return;
  const before = keyPool(target);
  const pool = clone(before).filter((credential) => credential.id !== id);
  if (pool.length === before.length || pool.length < 1) return;
  writeKeyPool(target, pool);
  await saveKeyPool(next);
}

/** The inline form, in place of "Add" or of the row being edited. */
function keyAccountForm(name, credential, index, pool) {
  const labelInput = el("input", { maxlength: "60", placeholder: t("providers.keyAccountNamePlaceholder") });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: credential ? t("providers.keyKeepCurrent") : t("providers.keyPlaceholder") });
  // The page redraws under the form (a probe finishing, a save elsewhere), so what is typed lives in
  // `keyForm` and comes back with the new inputs.
  const draft = keyForm;
  if (draft.label === undefined) draft.label = credential ? credential.label || "" : "";
  labelInput.value = draft.label;
  keyInput.value = draft.key || "";
  labelInput.addEventListener("input", () => { draft.label = labelInput.value; });
  keyInput.addEventListener("input", () => { draft.key = keyInput.value; });
  labelInput.addEventListener("focus", () => { draft.focus = "label"; });
  keyInput.addEventListener("focus", () => { draft.focus = "key"; });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const save = el("button", { class: "btn compact", type: "button", text: t("common.save") });
  save.addEventListener("click", () => void saveKeyAccount(name, credential ? credential.id : null, labelInput.value, keyInput.value, save));
  const cancel = el("button", { class: "btn secondary compact", type: "button", text: t("common.cancel") });
  cancel.addEventListener("click", () => { keyForm = null; renderProviderDetail(); });
  for (const input of [labelInput, keyInput]) input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) save.click();
    if (event.key === "Escape") cancel.click();
  });
  queueMicrotask(() => (draft.focus !== "key" ? labelInput : keyInput).focus());
  return el("div", { class: "cell key-account-form" }, [
    el("div", { class: "cell-text" }, [
      inputRow(t("providers.keyAccountName"), labelInput),
      el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.keyAccountKey") }), el("div", { class: "key-control" }, [keyInput, showKey])]),
      el("div", { class: "actions end" }, [cancel, save]),
    ]),
  ]);
}

function keyAccountRow(name, credential, index, pool) {
  if (keyForm && keyForm.provider === name && keyForm.id === credential.id) return keyAccountForm(name, credential, index, pool);
  const single = pool.length === 1;
  const label = keyLabel(credential, index);
  const key = keyOfHeaders(credential.headers);
  const usage = keyUsageText(name, index);
  const runtime = ((status && status.credentials && status.credentials[name]) || []).find((item) => item.id === credential.id);
  const account = { ...runtime, ...credential };
  const actions = accountPoolActions(account, (change) => patchKeyAccount(name, credential.id, change));
  const edit = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
  edit.addEventListener("click", () => { keyForm = { provider: name, id: credential.id }; renderProviderDetail(); });
  // The last key goes with the provider itself (개요 → 프로바이더 삭제), so it has no 삭제 here.
  const remove = single ? null : el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
  if (remove) remove.addEventListener("click", () => void removeKeyAccount(name, credential.id, label));
  return el("article", { class: "cell account-card" }, [
    el("div", { class: "cell-text account-card-copy" }, [
      el("strong", { text: label }),
      key ? el("span", { class: "small mono", text: maskKey(key) }) : null,
      usage ? quotaMeters(keyUsageWindows(name, index)) : null,
      el("div", { class: "account-card-actions" }, [...actions, edit, remove]),
    ]),
    el("div", { class: "account-card-badges" }, [
      account.preferred ? el("span", { class: "badge first", text: t("providers.preferBadge") }) : null,
      account.inUse ? el("span", { class: "badge ok in-use", text: t("providers.chatgptInUse") }) : null,
      keyStateBadge(name, account, single),
    ]),
  ]);
}

function renderKeyAccountRows(target, name) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[name];
  if (!provider) return;
  const pool = keyPool(provider);
  const rows = pool.map((credential, index) => keyAccountRow(name, credential, index, pool));
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.keyRequired") })]));
  const countNode = $("#key-account-count");
  if (countNode) countNode.textContent = t("providers.chatgptAccountCount", { count: pool.length });
}

async function refreshKeyAccountPanel(name) {
  const generation = providerDetailGeneration;
  // Status too: a key saved a moment ago has no state in the copy the five-second poll last brought.
  const [fresh, limits] = await Promise.allSettled([api("/api/status"), api("/api/limits")]);
  if (fresh.status === "fulfilled") status = fresh.value;
  keyLimits = limits.status === "fulfilled" ? limits.value : null;
  if (generation !== providerDetailGeneration || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  // A row being edited is left alone, so the usage arriving does not wipe what is being typed.
  if (keyForm && keyForm.provider === name && keyForm.id !== null) return;
  const target = $("#key-account-rows");
  if (target) renderKeyAccountRows(target, name);
}

function keyAccountsPanel(name) {
  const rows = el("div", { id: "key-account-rows", class: "account-card-list" });
  const adding = keyForm && keyForm.provider === name && keyForm.id === null;
  const add = el("button", { class: "cell-button account-add", type: "button", text: t("providers.addKeyAccount") });
  add.addEventListener("click", () => { keyForm = { provider: name, id: null }; renderProviderDetail(); });
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.keyAccountsTitle", { name: providerName(name) }) }), el("span", { id: "key-account-count", class: "small" })]),
      el("div", { class: "group account-group" }, [rows, adding ? keyAccountForm(name, null, -1, []) : add]),
      el("p", { class: "group-footer", text: t("providers.keyAccountsHelp") }),
    ]),
  ]);
  queueMicrotask(() => {
    renderKeyAccountRows(rows, name);
    void refreshKeyAccountPanel(name);
  });
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
  // Removing is the one destructive act on this page, so it sits apart at the bottom, not beside Edit.
  const remove = el("button", { class: "cell-button destructive", type: "button", text: t("providers.remove"), onclick: () => void removeProvider(name, provider) });
  const back = el("button", { class: "provider-back", type: "button", onclick: closeProviderDetail }, [svgIcon("0 0 9 15", ["M7.5 1.5l-6 6 6 6"]), el("span", { text: t("nav.providers") })]);
  // The name people know it by, in its vendor's hue; under it the kind and, when the name is not the
  // key, the key itself, since routes, the picker and the config file name the provider by it.
  const title = providerName(name, provider);
  const header = el("header", { class: "provider-detail-header" }, [
    el("div", {}, [
      el("div", { class: "provider-title-line" }, [vendorDot(name, provider), el("h2", { text: title }), providerState(name, provider)]),
      el("p", { class: "small provider-kind" }, [el("span", { text: providerKind(name, provider) }), title !== name ? el("span", { class: "mono provider-key", text: name }) : null]),
    ]),
    el("div", { class: "provider-detail-actions" }, [check, edit]),
  ]);
  let content;
  if (providerDetailTab === "accounts" && provider.type === "anthropic" && provider.auth === "claude-code") content = anthropicAccountsPanel(name, provider);
  else if (providerDetailTab === "accounts" && provider.type === "chatgpt") content = chatgptAccountsPanel(name);
  else if (providerDetailTab === "accounts" && provider.type === "google" && provider.auth === "antigravity") content = googleAccountsPanel(name);
  else if (providerDetailTab === "accounts" && isKeyProvider(provider)) content = keyAccountsPanel(name);
  else if (providerDetailTab === "models") content = providerModelsPanel(name, provider);
  else { providerDetailTab = "overview"; content = providerOverview(name, provider); }
  // The destructive acts share one card at the bottom: on a Claude login's accounts, signing every added account out, then removing the provider.
  const logoutAll = providerDetailTab === "accounts" && provider.type === "anthropic" && provider.auth === "claude-code" ? anthropicLogoutAllButton(name) : null;
  detail.replaceChildren(back, header, providerTabs(name, provider), el("div", { id: "provider-tab-panel", role: "tabpanel", "aria-labelledby": `provider-tab-${providerDetailTab}` }, [content]), el("div", { class: "group provider-remove" }, [logoutAll, remove]));
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
    pickerContextWindows = await api("/api/context-windows");
    if (!status) status = await api("/api/status");
    renderClients();
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}

async function loadProviders() {
  providersLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    // The Models tab says which models have no known window, and the live Codex catalogue's is not
    // in the config. A router too old to answer leaves the note off rather than breaking the screen.
    pickerContextWindows = await api("/api/context-windows").catch(() => pickerContextWindows);
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
/** What had focus when the dialog opened, restored when it closes (G-D10). */
let modalOpener = null;
function showModal(content, cleanup) {
  if (modalCleanup) modalCleanup();
  modalCleanup = cleanup || null;
  // Where the keyboard was before the dialog opened: closing puts it back there instead of on <body> (G-D10).
  const active = document.activeElement;
  modalOpener = active && typeof active.focus === "function" ? active : null;
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
  const opener = modalOpener;
  modalOpener = null;
  if (opener && opener.isConnected) opener.focus();
}
/**
 * The dialog's own focusables, in tab order. Hidden and disabled controls stay out: Tab must not
 * land on a field the screen does not show.
 */
function modalFocusables() {
  return $all("#modal-content button, #modal-content input, #modal-content select, #modal-content textarea, #modal-content a[href]", $("#modal-content"))
    .filter((node) => !node.disabled && node.getClientRects().length > 0);
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal-backdrop").addEventListener("click", (event) => { if (event.target === $("#modal-backdrop")) closeModal(); });
window.addEventListener("keydown", (event) => {
  // keyCode 229 also covers the IME commit key on browsers that already cleared isComposing.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || $("#modal-backdrop").hidden) return;
  if (event.key === "Escape") { closeModal(); return; }
  // Tab stays inside the dialog: the page behind it is inert to the pointer, and a keyboard that
  // walked out into it could press something the dialog is covering (G-D10).
  if (event.key === "Tab") {
    const focusables = modalFocusables();
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey ? active === first || !$("#modal-content").contains(active) : active === last || !$("#modal-content").contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
    return;
  }
  if (event.key !== "Enter" || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  // Only single-line text entry gets the shortcut. Buttons (including Cancel), selects, links,
  // checkboxes, textareas and editable regions keep their own native keyboard behaviour.
  const target = event.target;
  if (!$("#modal-content").contains(target) || target.tagName !== "INPUT" || target.isContentEditable) return;
  if (!["text", "search", "email", "url", "tel", "password", "number"].includes(target.type)) return;
  const action = $("#modal-content [data-default-action]");
  if (action && !action.disabled) { event.preventDefault(); action.click(); }
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
  // Claude's own API key is the native provider's API-key mode, offered here beside the other keys.
  group(t("providers.anthropicGroup"), [tile("Claude API", null, { kind: "anthropic", auth: "api-key" }), ...native.map((preset) => tile(preset.name, null, { preset }))], t("providers.presetHelp"));
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
  const displayName = options.name ? providerLabel(options.name, existing) : options.auth === "api-key" ? "Claude API" : t("providers.anthropic");
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const auth = el("select", {}, [selectOption("claude-code", t("providers.anthropicAuthClaudeCode")), selectOption("api-key", t("providers.anthropicAuthApiKey"))]);
  auth.value = (existing && existing.auth) || options.auth || "claude-code";
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: existing && existing.apiKey ? t("providers.keySaved") : t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const sourceLine = el("div", { class: "small" });
  let foundModels = modelsOf(existing).length ? modelsOf(existing) : claudeModels.map((model) => ({ id: model.id, name: labelOf(model) }));
  let selected = new Set(existing ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
  // What the checklist started with: a new provider's list is drawn from the fallback catalogue, and
  // a first live listing may fill in the rest only while the user has left that set as it was.
  const initialSelection = new Set(selected);
  let listed = false;
  const modelArea = el("div", { class: "form-field" });
  function renderModels() {
    const modelsBox = modelChecklist(foundModels, selected);
    // An API key's models are workers, not mapping choices: the mode hint below says so instead.
    modelArea.replaceChildren(...[el("span", { text: t("providers.models") }), auth.value === "api-key" ? null : hint(t("providers.modelsHelp")), el("small", { text: t("providers.effortLevels", { levels: "low · medium · high · max" }) }), modelsBox].filter(Boolean));
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
  auth.addEventListener("change", renderModels);
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
        // What is ticked now wins: this listing arrives after the form opened, so it must not re-tick
        // a model the user just unchecked. Only a new provider's first listing — one whose selection
        // still matches the fallback set the form opened with — starts with all of them.
        const ticked = modelArea.querySelector(".model-picker").selected().map((model) => model.id);
        const untouched = ticked.length === initialSelection.size && ticked.every((id) => initialSelection.has(id));
        const keep = tickedAfterListing(!existing && !listed && untouched, ticked, response.models.map((model) => model.id));
        listed = true;
        const named = new Set(response.models.map((model) => model.id));
        foundModels = [...response.models, ...modelsOf(existing).filter((model) => !named.has(model.id))];
        selected = keep;
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
  function syncModeHint() { modeHint.textContent = auth.value === "api-key" ? t("providers.anthropicApiKeyWorkers") : accountPool ? t("providers.anthropicPoolRouting") : t("providers.anthropicIngressOnly"); }
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
    next.providers[providerName] = applyProviderLabel(provider, providerName, typedName);
    // accountPool makes these models native Claude routing targets. Without it this remains the
    // historical OpenAI ingress provider, and routing deliberately ignores it.
    saveButton.disabled = true;
    try { const out = await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = auth.value === "claude-code" ? "accounts" : "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); configSaved(out, t("common.saved")); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  if (auth.value === "claude-code") void runProbe();
}
/**
 * What a model list's check leaves ticked. A caller may start a new provider's first listing with
 * everything ticked (Grok, Claude). Every later check — and every check of a saved provider — keeps
 * what is ticked at that moment, so a model the user unticked stays unticked.
 */
function tickedAfterListing(firstListing, tickedIds, listedIds) {
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
  const nameInput = el("input", { value: options.name ? providerLabel(options.name, existing) : t("providers.grok"), maxlength: "60" });
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  let foundModels = modelsOf(existing);
  const currentChecked = new Set(foundModels.map((model) => model.id));
  // What the checklist opened with. The first listing fills it out only while the person has left
  // that set as it was: a model typed in before the list arrived is theirs and stays ticked (B21).
  const initialSelection = new Set(currentChecked);
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
        const tickedIds = ticked.map((model) => model.id);
        const untouched = tickedIds.length === initialSelection.size && tickedIds.every((id) => initialSelection.has(id));
        const keep = tickedAfterListing(!existing && !listed && untouched, tickedIds, response.models.map((model) => model.id));
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
    // A Clients-screen picker save still open would land after this one and rebuild the list from
    // the screen it read before: let it land first, so this save starts from what it stored.
    await pickerSaving.catch(() => {});
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
    applyProviderLabel(next.providers[providerName], providerName, typedName);
    applyPickerSelections(next, providerPickerSelections(next, providerName, saved, checkedModels, pickerInput.checked), true);
    saveButton.disabled = true;
    try { const out = await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); configSaved(out, t("common.saved")); await offerPickerOn(pickerInput.checked && checkedModels.length > 0); }
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
  const nameInput = el("input", { value: options.name ? providerLabel(options.name, existing) : t("providers.google"), maxlength: "60" });
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
        // rather than all of them; saved and typed picks stay ticked and visible. The box as it is
        // now is the answer: merging the saved set back in re-ticked a model the user unchecked
        // while the listing was still in flight.
        const keep = new Set(ticked.map((model) => model.id));
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
    // As in the Grok form: an open Clients-screen picker save lands first.
    await pickerSaving.catch(() => {});
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
    applyProviderLabel(next.providers[providerName], providerName, typedName);
    // Same rule as the other provider forms: read after the provider is updated, so an unticked
    // model is already undeclared and falls out of the picker on its own.
    applyPickerSelections(next, providerPickerSelections(next, providerName, saved, checkedModels, pickerInput.checked), true);
    saveButton.disabled = true;
    try { const out = await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = auth.value === "antigravity" ? "accounts" : "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); configSaved(out, t("common.saved")); await offerPickerOn(pickerInput.checked && checkedModels.length > 0); }
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
  const displayName = (options.name && providerLabel(options.name, existing)) || (preset && preset.name) || (isChatgpt ? t("providers.chatgpt") : isAnthropic ? t("providers.anthropic") : t("providers.customName"));
  if (isAnthropic) { openAnthropicProviderForm(options); return; }
  if (options.kind === "google" || (existing && existing.type === "google")) { openGoogleProviderForm(options); return; }
  if (options.kind === "grok" || (existing && existing.type === "grok")) { openGrokProviderForm(options); return; }
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const currentHeaders = (existing && existing.headers) || {};
  const headerKind = preset ? preset.authHeader : (isOpenAi || Object.keys(currentHeaders).some((key) => key.toLowerCase() === "authorization") ? "authorization-bearer" : "x-api-key");
  const authHeader = Object.entries(currentHeaders).find(([name]) => name.toLowerCase() === (headerKind === "authorization-bearer" ? "authorization" : "x-api-key"));
  const existingKey = authHeader ? normalizeKey(authHeader[1]) : "";
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
    advancedContent.appendChild(inputRow(t("providers.extraHeaders"), extraHeaders, t("providers.extraHeadersHelp")));
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
  function readHeaders(baseHeaders = currentHeaders) {
    // Empty means keep the key, not replay the credentials captured when this form opened.
    const headers = Object.fromEntries(Object.entries(baseHeaders).filter(([name]) => isKeyHeader(name)));
    const kind = keyInput.dataset.headerKind || headerKind;
    const key = normalizeKey(keyInput.value);
    if (key) {
      for (const name of Object.keys(headers)) delete headers[name];
      if (kind === "authorization-bearer") headers.authorization = `Bearer ${key}`;
      else headers["x-api-key"] = key;
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
      ...(Object.keys(readHeaders()).length ? { headers: readHeaders() } : {}),
    };
  }
  function probeDraft() {
    const d = draftProvider();
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
  let modelsListed = Boolean(existing);
  let modelsEdited = false;
  modelArea.addEventListener("change", () => { modelsEdited = true; });
  async function runProbe() {
    const draft = probeDraft();
    if (!draft.url || !/^https?:\/\//.test(draft.url)) { toast(t("providers.urlRequired"), true); return; }
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    const temporary = `__new_${Date.now()}`;
    const response = await probeProvider(temporary, draft);
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
    const keep = modelsListed || modelsEdited || foundModels.length > 12 ? new Set(ticked.map((m) => m.id)) : new Set(foundModels.map((model) => model.id));
    modelsListed = true;
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
      const keep = new Set(modelArea.querySelector(".model-picker").selected().map((model) => model.id));
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
    if (!isChatgpt && (!provider.url || !/^https?:\/\//.test(provider.url))) { toast(t("providers.urlRequired"), true); return; }
    // As in the Grok form: an open Clients-screen picker save lands first.
    await pickerSaving.catch(() => {});
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers, provider.url);
    const saved = existing && (next.providers[options.name] || existing);
    if (!isChatgpt) {
      const headers = readHeaders((saved && saved.headers) || {});
      if (Object.keys(headers).length) provider.headers = headers;
      else delete provider.headers;
      // Caps are catalogue/hand-written data, not fields this form edits.
      if (existing) delete provider.caps;
    }
    if (existing && providerName !== options.name) delete next.providers[options.name];
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    provider.models = checkedModels;
    // The form rebuilds the provider from its own fields, so anything it has no field for
    // (debugDump, a hand-written setting) is carried over from the saved one rather than dropped.
    // A field the form owns is left to the draft, so clearing it in the form still clears it.
    const formKeys = new Set(isChatgpt
      ? ["type", "auth", "defaultEffort", "identity", "limits", "instructionsAppend", "fast", "models"]
      : ["type", "url", "identity", "limits", "instructionsAppend", "preset", "sessionHeader", "wire", "headers", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = applyProviderLabel({ ...kept, ...provider }, providerName, typedName);
    // A pooled provider's first key is `headers` and `credentials[0]` at once (the 계정 tab), so a
    // key changed here must change both, or the pool keeps sending the old one.
    const pooled = next.providers[providerName].credentials;
    if (Array.isArray(pooled) && pooled.length && normalizeKey(keyInput.value) && provider.headers) pooled[0] = { ...pooled[0], headers: { ...provider.headers } };
    // Read after `next.providers` has been updated, so an unticked model is already undeclared here
    // and falls out on its own, and a renamed provider answers to its new name.
    applyPickerSelections(next, providerPickerSelections(next, providerName, saved, checkedModels, pickerInput.checked), pickerInput.checked);
    saveButton.disabled = true;
    try {
      const out = await configRequest(next);
      currentConfig = next;
      selectedProviderName = providerName;
      providerDetailTab = "overview";
      slotsLoaded = false;
      providersLoaded = false;
      closeModal();
      await loadProviders();
      configSaved(out, t("common.saved"));
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
// A domain ladder has two levels: light work (the light rung) and heavy work (standard, hard, plan).
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
  compactModel: "claude-haiku-5-5", compactModels: [],
  swampAlert: false, layout: "dashboard", appearance: "auto", skin: "deep", language: "auto", hide: ["reason"], extras: [], setupDone: false,
};

// The compaction point presets, in tokens (Claude Code's own `autoCompactWindow`), and its range.
const MOD_COMPACT_PRESETS = [400000, 500000, 600000];
const MOD_COMPACT_MIN = 100000;
const MOD_COMPACT_MAX = 1000000;

// `base` is the router's copy `settings` was edited from: what differs between them is this page's own change.
// `compactAt` is Claude Code's own compaction window (settings.json `autoCompactWindow`), saved apart.
let modState = { settings: null, base: null, revision: 0, options: null, compactAt: null, retiredNote: false };
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
 * and arrays whole except keyed lists (modes by default), objects field by field, and a rule whose
 * mode changed replaced whole. Config saves reuse this with their own list identities.
 * @param {Object} before
 * @param {Object} after
 * @param {string[]} path
 * @param {Record<string, string>} arrayKeys Identity fields for lists that merge entry by entry.
 */
function modChanges(before, after, path = [], arrayKeys = { modes: "id" }) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (after === undefined) return [{ path, remove: true }];
  const arrayKey = arrayKeys[path.at(-1)];
  if (arrayKey && Array.isArray(before) && Array.isArray(after) && [...before, ...after].every((entry) => entry && typeof entry[arrayKey] === "string")) {
    const byId = (entries) => Object.fromEntries(entries.map((entry) => [entry[arrayKey], entry]));
    return modChanges(byId(before), byId(after), path, arrayKeys);
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObject(before) && isObject(after) && before.mode === after.mode) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => modChanges(before[key], after[key], [...path, key], arrayKeys));
  }
  return [{ path, value: after }];
}
/** Apply changed paths, resolving keyed-list path segments by their stable identity, not position. */
function modApply(base, changes, arrayKeys = { modes: "id" }) {
  const result = clone(base);
  for (const change of changes) {
    const key = change.path.at(-1);
    if (key === undefined) continue;
    let parent = result;
    let arrayKey;
    for (const step of change.path.slice(0, -1)) {
      if (Array.isArray(parent)) {
        let entry = parent.find((item) => item[arrayKey] === step);
        if (!entry) { entry = { [arrayKey]: step }; parent.push(entry); }
        parent = entry;
      } else {
        arrayKey = arrayKeys[step];
        if (!parent[step] || typeof parent[step] !== "object") parent[step] = arrayKey ? [] : {};
        parent = parent[step];
      }
    }
    if (Array.isArray(parent)) {
      const index = parent.findIndex((entry) => entry[arrayKey] === key);
      if (change.remove) { if (index >= 0) parent.splice(index, 1); }
      else if (index >= 0) parent[index] = clone(change.value);
      else parent.push(clone(change.value));
    } else if (change.remove) delete parent[key];
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
  modState.compactAt = typeof snapshot.compactAt === "number" && Number.isFinite(snapshot.compactAt) ? snapshot.compactAt : null;
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
        out = await api("/api/mod-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 2, settings: sent, revision: modState.revision }) });
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
/**
 * Claude Code's compaction point is `autoCompactWindow` in settings.json, a file of its own: saving
 * it here writes the same key `/autocompact <n>` does (or removes it for the model's default), so a
 * session and this page always agree. It is not part of the mod's settings revision.
 */
async function saveCompactAt(value) {
  const previous = modState.compactAt;
  modState.compactAt = value;
  modRefresh();
  modStatus(t("slots.saving"));
  try {
    const out = await api("/api/mod-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 2, compactAt: value }) });
    modState.compactAt = out && typeof out.compactAt === "number" && Number.isFinite(out.compactAt) ? out.compactAt : null;
    modStatus(t("mod.saved"));
  } catch (error) {
    modState.compactAt = previous;
    modStatus(`${t("common.saveFailed")} ${error.message}`, true);
  }
  modRefresh();
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
  modRedraw($("#mod-content"), [modEffortCard(), modWorkersCard(), modJudgeCard(), modCacheCard(), modCompactCard(), modLookCard()]);
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
    const pinned = agent.account !== undefined || typeof agent.accountNumber === "number";
    return {
      // A pinned worker runs on one stored account: its number (the limits' "Claude n") picks the
      // account tab it is listed under, so the label stays the bare model.
      value: agent.name, label: agent.model, model: agent.model, provider: agent.provider,
      pinned, accountNumber: pinned && typeof agent.accountNumber === "number" ? agent.accountNumber : null, accountName: agent.account || "",
      billing: /(?::|-)free$/i.test(agent.model) ? "free" : agent.billing || (info && info.billing) || null,
      // A spent quota group lists its models under `models` while the provider still answers others.
      usable: !info || (info.usable !== false && !(info.models && info.models[agent.model])),
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

// ---- Accounts: a provider with pinned workers lists one account at a time
//
// Account 1 is the provider's default: its ordinary workers, which run on the pool's own choice
// (preferred account, else the saved order). Accounts 2… list their pinned workers. The numbers are
// the limits' "Claude n"/"GPT n" (/api/mod-options `accounts`). The pinned workers of account 1, and
// of an account no longer stored, are not listed; they stay valid where a setting already names them.

/** The account tab a provider group shows, kept while the page is open; never saved. @type {Map<string, number>} */
const modAccountTabs = new Map();
/** The account a choice is listed under: 1 for an ordinary worker, its own number for a pinned one. */
function modAccountOf(choice) { return choice.pinned ? choice.accountNumber : 1; }
/** Whether a choice is listed at all: an ordinary worker, or a pinned one on account 2 or later. */
function modListed(choice) { return !choice.pinned || choice.accountNumber > 1; }
/** A choice's name where its account is not otherwise shown (a pick no longer offered, a hidden pin). */
function modChoiceName(choice) {
  if (!choice.pinned || !choice.accountNumber && !choice.accountName) return choice.label;
  const account = choice.accountNumber > 1 || !choice.accountName ? t("mod.accountTab", { n: choice.accountNumber }) : choice.accountName;
  return `${choice.label} · ${account}`;
}
/** A worker group's account tabs (`{number, label}`), or null when it has one account to show. */
function modAccountTabsOf(group) {
  if (!group.items.length || group.items[0].claude) return null;
  const numbers = new Set(group.items.filter((choice) => choice.pinned && modListed(choice)).map((choice) => choice.accountNumber));
  if (!numbers.size) return null;
  const info = modProviderInfo(group.items[0].provider);
  const accounts = info && Array.isArray(info.accounts) ? info.accounts : [];
  const tabs = [1, ...[...numbers].sort((a, b) => a - b)].map((number) => accounts.find((account) => account.number === number) || { number });
  return tabs.length > 1 ? tabs : null;
}
/** The tab shown for a group: the one picked here while it still exists, else account 1. */
function modAccountTab(group, tabs) {
  const picked = modAccountTabs.get(group.name);
  return tabs.some((tab) => tab.number === picked) ? picked : 1;
}

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
    const tabs = modAccountTabsOf(group);
    const box = (choice) => {
      const on = modTicked(choice);
      const account = tabs ? ` · ${t("mod.accountTab", { n: modAccountOf(choice) })}` : "";
      const input = el("input", { type: "checkbox", "data-key": `tick:${modTickKey(choice)}`, "aria-label": `${choice.label} · ${group.name}${account}`, checked: on });
      if (on && onCount === 1) input.disabled = true;
      input.addEventListener("change", () => modTick(choice, input.checked));
      // A model paid differently from its group (a :free model on a paid provider) says so beside its name.
      const other = choice.billing && choice.billing !== group.billing ? el("span", { class: "model-effort-tag", text: t(`mod.billing.${choice.billing}`) }) : null;
      const off = choice.usable ? null : el("span", { class: "model-effort-tag warn-text", text: t("mod.notUsable") });
      return el("label", { class: "model-check", title: choice.model || choice.label }, [input, el("span", { text: choice.label }), other, off]);
    };
    const listed = group.items.filter(modListed);
    if (!tabs) return el("div", { class: "tick-group" }, [el("div", { class: "tick-head", text: modGroupLabel(group) }), el("div", { class: "model-checklist" }, listed.map(box))]);
    // Every account's list is drawn in the same place and only the picked one is visible, so the
    // block keeps the tallest list's height and switching accounts moves nothing below it.
    const shown = modAccountTab(group, tabs);
    const id = (number) => `mod-account-${group.name}-${number}`;
    const tabList = el("div", { class: "segmented account-tabs", role: "tablist", "aria-label": group.name }, tabs.map((tab) => el("button", {
      type: "button", role: "tab", class: tab.number === shown ? "active" : "", "aria-selected": String(tab.number === shown), "aria-controls": id(tab.number),
      "data-key": `account-tab:${group.name}:${tab.number}`, text: t("mod.accountTab", { n: tab.number }), ...(tab.label ? { title: tab.label } : {}),
      onclick: () => { if (tab.number !== shown) { modAccountTabs.set(group.name, tab.number); modRefresh(); } },
    })));
    const panels = tabs.map((tab) => {
      const panel = el("div", { class: `model-checklist${tab.number === shown ? "" : " account-hidden"}`, id: id(tab.number), role: "tabpanel" }, listed.filter((choice) => modAccountOf(choice) === tab.number).map(box));
      if (tab.number !== shown) { panel.inert = true; panel.setAttribute("aria-hidden", "true"); }
      return panel;
    });
    return el("div", { class: "tick-group" }, [
      el("div", { class: "tick-head has-tabs" }, [el("span", { text: modGroupLabel(group) }), tabList]),
      el("div", { class: "account-panels" }, panels),
    ]);
  });
}

// ---- The four workers: a meaning, the pick, and one menu to change it

/** The general ladder's rungs; the router fills any that are empty, so a missing one is only a failed load. */
function modRungs() {
  const general = modState.settings.rules.general;
  return general && general.mode === "ladder" && general.rungs ? general.rungs : {};
}
/** A domain ladder folded into two levels, as the mod folds it (settings.ts twoLevelRungs): light
 * work is light+standard, heavy work hard+plan. */
function modTwoLevelRungs(rungs) {
  const out = {};
  const filled = (list) => list && list.length;
  const light = filled(rungs.light) ? rungs.light : rungs.standard;
  const heavy = [rungs.plan, rungs.hard, rungs.standard, rungs.light].find(filled);
  if (filled(light)) { out.light = clone(light); out.standard = clone(light); }
  if (heavy) { out.hard = clone(heavy); out.plan = clone(heavy); }
  return out;
}
/** One menu of `model · effort` for the ticked models, effort limited to what each model takes; the session's model too. */
function modPickSelect(key, step, shown, label, onPick) {
  const picked = step ? modTargetValue(step.target) : "";
  // An unlisted pinned worker (account 1's, see modListed) is offered only where it is the pick already.
  const choices = modChoices().filter((choice) => choice.value === "general-purpose" || modTicked(choice) && (modListed(choice) || choice.value === picked));
  const entries = (list) => list.flatMap((choice) => {
    // A closed menu shows the option alone, not its group: a pinned worker names its account there.
    const number = modListed(choice) ? modAccountOf(choice) : null;
    const name = modListed(choice) ? (number && number > 1 ? `${choice.label} · ${t("mod.accountTab", { n: number })}` : choice.label) : modChoiceName(choice);
    return modLadderOf(choice).map((effort) => ({ value: `${choice.value}|${effort}`, label: `${name} · ${modEffortName(effort)}${choice.usable ? "" : t("mod.unavailableNow")}` }));
  });
  // A provider with account tabs gets one group per account, named as its tab is.
  const all = modGroups(modTickable());
  const groups = modGroups(choices).flatMap((group) => {
    const whole = all.find((entry) => entry.name === group.name);
    const tabs = whole ? modAccountTabsOf(whole) : null;
    if (!tabs) return [{ group: modGroupLabel(group), items: entries(group.items) }];
    return tabs.map((tab) => ({ group: `${modGroupLabel(group)} · ${t("mod.accountTab", { n: tab.number })}`, items: entries(group.items.filter((choice) => modAccountOf(choice) === tab.number)) }));
  });
  const current = step ? `${picked}|${shown}` : "";
  const items = [...(step ? [] : [{ value: "", label: "—" }]), ...groups];
  // A pick that is not on offer now (its model unticked, or gone) keeps showing rather than a wrong neighbour.
  if (step && !groups.some((group) => group.items.some((item) => item.value === current))) {
    const choice = modChoiceOf(step.target);
    items.unshift({ value: current, label: `${choice ? modChoiceName(choice) : picked} · ${modEffortName(shown)}${t("mod.unavailable")}` });
  }
  return modSelect(key, items, current, label, (value) => {
    if (!value) return;
    const bar = value.lastIndexOf("|");
    onPick(modTargetOf(value.slice(0, bar)), value.slice(bar + 1));
  }, "rung-model");
}
/** @typedef {"general" | "ui" | "backend" | "review"} WorkerRuleKey */
/** Domain selection is local UI state, independently retained for each saved worker set.
 * @type {Map<string, WorkerRuleKey>}
 */
const modRuleTabs = new Map();
/** Save only this set's optional rule; deleting it makes the set follow its own general ladder.
 * @param {import("../mod/types").Mode | undefined} mode
 * @param {"ui" | "backend" | "review"} key
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
    { value: "review", label: t("mod.domain.review") },
  ], key, t("mod.workerDomain"), (value) => { modRuleTabs.set(id, value); modRefresh(); }), null, "wide")];
  if (key !== "general") rows.push(cell(t("mod.domainSeparate"), modSwitch(`worker-separate:${id}:${key}`, !!rule, t("mod.domainSeparate"), (on) => {
    // Switching on copies the set's general rungs, folded the same way a domain ladder is.
    modSetDomainRule(mode, key, on ? { mode: "ladder", rungs: modTwoLevelRungs(mode ? mode.rungs : modRungs()) } : undefined);
  }), rule ? t("mod.domainLevelNote") : t("mod.domainFollowsGeneral"), "wide"));
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
    const choice = modChoices().find((item) => item.value !== "general-purpose" && modTicked(item) && modListed(item)) || modChoices().at(-1);
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
      // The level's top rung shows the list; an edit writes it to every rung of the level.
      const shown = [...level.rungs].reverse().find((rung) => rungs[rung] && rungs[rung].length);
      const steps = shown ? rungs[shown] : [];
      const save = (next) => {
        const updated = { ...rungs, ...Object.fromEntries(level.rungs.map((rung) => [rung, clone(next)])) };
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

/**
 * The compaction model choices: the app's own compactor, Claude's three models, then the router's
 * models grouped by provider. Values are model ids, as a worker's are.
 */
function modCompactModelItems() {
  const claude = ["haiku", "sonnet", "opus"].map((name) => ({ value: MOD_CLAUDE_IDS[name], label: `Claude ${modCap(name)}` }));
  const seen = new Set(claude.map((item) => item.value));
  const groups = new Map();
  for (const model of (modState.options && modState.options.models) || []) {
    if (!model || model.judgeOnly || typeof model.model !== "string" || !model.model || seen.has(model.model)) continue;
    seen.add(model.model);
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push({ value: model.model, label: model.name || model.model });
  }
  return [
    { value: "session", label: t("mod.compactSession") },
    { group: "Claude", items: claude },
    ...[...groups].map(([provider, items]) => ({ group: provider, items })),
  ];
}

function modCompactChoices(s) {
  const choices = s.compactModels || [];
  const items = modCompactModelItems();
  const rows = choices.map((value, index) => el("li", { class: "rung-item" }, [
    modSelect(`compact-choice:${index}`, items, value, t("mod.compactChoices"), (next) => {
      if (!choices.includes(next)) modPatch({ compactModels: choices.map((item, at) => at === index ? next : item) });
      else modRefresh();
    }, "rung-model"),
    el("div", { class: "rung-actions" }, [el("button", { type: "button", class: "btn secondary compact", "data-key": `compact-remove:${index}`, text: "✕", "aria-label": t("common.remove"), onclick: () => modPatch({ compactModels: choices.filter((_, at) => at !== index) }) })]),
  ]));
  const available = items.flatMap(item => item.group ? item.items : [item]).find(item => item.value !== s.compactModel && !choices.includes(item.value));
  const add = el("button", { type: "button", class: "btn secondary compact", "data-key": "compact-add", text: t("mod.modeAddModel"), ...(!available || choices.length >= 4 ? { disabled: "" } : {}), onclick: () => { if (available) modPatch({ compactModels: [...choices, available.value] }); } });
  return cell(t("mod.compactChoices"), el("div", { class: "rung-list" }, [el("ol", {}, rows), add]), t("mod.compactChoicesHint"), "wide rung-row");
}

function modCompactCard() {
  const s = modState.settings;
  const at = modState.compactAt;
  const choice = at === null ? "default" : MOD_COMPACT_PRESETS.includes(at) ? String(at) : "custom";
  const preset = modSegmented("compact-at", [
    ...MOD_COMPACT_PRESETS.map((tokens) => ({ value: String(tokens), label: `${tokens / 1000}k` })),
    { value: "default", label: t("mod.compactAtDefault") },
  ], choice, t("mod.compactAt"), (value) => { void saveCompactAt(value === "default" ? null : Number(value)); });
  const custom = el("input", {
    type: "number", class: "text-field", "data-key": "compact-at-custom",
    min: String(MOD_COMPACT_MIN / 1000), max: String(MOD_COMPACT_MAX / 1000), step: "10",
    value: at !== null && choice === "custom" ? String(at / 1000) : "",
    placeholder: t("mod.compactAtCustom"), "aria-label": t("mod.compactAtCustom"),
  });
  custom.addEventListener("change", () => {
    const tokens = Math.round(Number(custom.value) * 1000);
    if (!custom.value.trim() || !Number.isFinite(tokens) || tokens < MOD_COMPACT_MIN || tokens > MOD_COMPACT_MAX) {
      modStatus(t("mod.compactAtRange"), true);
      custom.value = at !== null && choice === "custom" ? String(at / 1000) : "";
      return;
    }
    void saveCompactAt(tokens);
  });
  const outOfRange = at !== null && (at < MOD_COMPACT_MIN || at > MOD_COMPACT_MAX);
  const hint = outOfRange ? t("mod.compactAtRange") : modCap(t("mod.compactAtHint"));
  return modCard("compact", t("mod.compaction"), t("mod.compactionBlurb"), [modSection(null, [
    cell(t("mod.compactModel"), modSelect("compact-model", modCompactModelItems(), s.compactModel, t("mod.compactModel"), (compactModel) => modPatch({ compactModel })), null, "wide"),
    modCompactChoices(s),
    cell(t("mod.compactAt"), el("div", { class: "mode-until compact-at" }, [preset, custom]), el("span", { class: outOfRange ? "cell-sub warn-text" : undefined, text: hint }), "wide"),
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

// ---- Cost: what a period's requests would cost at public API prices (2026-11-09). A subscription's
// requests are shown at what the API would have charged. A row with no known price says "—", never
// $0.00 (free); a total that includes an estimated cache rate is marked "≈"; a bucket the router
// sent no cost for (one that does not price requests yet) shows no cost at all.
function costUsdText(usd) {
  if (!(usd > 0)) return "$0.00";
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** A bucket's amount, "—" for one nothing of which was priced, or null when it carries no cost. */
function costFigureOf(bucket) {
  if (!bucket || typeof bucket.costUsd !== "number" || !Number.isFinite(bucket.costUsd)) return null;
  if (bucket.costUsd <= 0 && bucket.unpricedRequests > 0) return "—";
  return `${bucket.estimatedRequests > 0 ? "≈" : ""}${costUsdText(bucket.costUsd)}`;
}
/** What a bucket's amount leaves out or estimates, as the sentences the note carries; for a row's hover. */
function costCaveatsOf(bucket) {
  const lines = [];
  if (bucket && bucket.unpricedRequests > 0) lines.push(t("logs.cost.unpriced", { count: formatNumber(bucket.unpricedRequests) }));
  if (bucket && bucket.estimatedRequests > 0) lines.push(t("logs.cost.estimated", { count: formatNumber(bucket.estimatedRequests) }));
  return lines;
}
/** The note under the summary: how the amounts are worked out, then what they leave out. */
function renderCostNote(total) {
  const note = $("#logs-cost-note");
  const shown = costFigureOf(total) !== null;
  note.hidden = !shown;
  note.replaceChildren(...(shown ? [t("logs.cost.note"), ...costCaveatsOf(total)] : []).map((line) => el("div", { text: line })));
}

const EMPTY_BUCKET = { count: 0, ok: 0, failed: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, avgMs: 0, cacheHitPercent: 0, conversationTokens: 0 };
function renderSummary(summary) {
  const providers = (summary && summary.providers) || {};
  const total = (requestProvider ? providers[requestProvider] : summary && summary.total) || EMPTY_BUCKET;
  const cost = costFigureOf(total);
  const chips = [
    summaryChip(t("logs.summary.requests"), formatNumber(total.count)),
    summaryChip(t("logs.summary.success"), `${formatNumber(total.ok)} / ${formatNumber(total.failed)}`),
    // The router groups conversations: last whole prompt + every output, as on the Agents card.
    // Input/output and the model table keep their independent request-volume accounting.
    summaryChip(t("logs.th.tokens"), formatNumber(total.conversationTokens)),
    // On its own line: with the whole input counted the number runs to eight digits, and the
    // ellipsis on one line cut the cache rate off entirely.
    summaryChip(t("logs.summary.input"), formatNumber(totalInputOf(total)), t("logs.cacheHit", { percent: total.cacheHitPercent || 0 })),
    summaryChip(t("logs.summary.output"), formatNumber(total.output)),
  ];
  if (cost !== null) chips.push(summaryChip(t("logs.summary.cost"), cost, t("logs.cost.basis")));
  chips.push(summaryChip(t("logs.summary.duration"), formatSeconds(total.avgMs)));
  $("#logs-summary").classList.toggle("with-cost", cost !== null);
  $("#logs-summary").replaceChildren(...chips);
  renderCostNote(total);
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
  const key = names.map((name) => `${name}\t${providerLabel(name)}`).join("\n");
  const select = $("#logs-provider");
  if (key !== renderedProviderNames) {
    renderedProviderNames = key;
    select.replaceChildren(el("option", { value: "", text: t("logs.all") }), ...names.map((name) => el("option", { value: name, text: providerLabel(name) })));
  }
  if (select.value !== requestProvider) select.value = requestProvider;
}
async function loadConfiguredProviders() {
  if (configuredProviders || currentConfig) return;
  try { configuredProviders = (await api("/api/config")).providers || {}; } catch { /* the usage and requests still name their providers */ }
}
/** A model row's cost: its amount (or "—"), what it leaves out or estimates on hover; "—" from a router that sends none. */
function modelCostCell(entry) {
  const figure = costFigureOf(entry);
  const caveats = costCaveatsOf(entry);
  return el("td", { class: "c-cost", "data-label": t("logs.th.cost"), title: caveats.length ? caveats.join(" ") : undefined }, [figure === null ? "—" : figure]);
}
function modelUsageRow(entry) {
  const total = totalInputOf(entry);
  const rate = modelRateOf(entry);
  const model = el("div", { class: "request-models" }, [
    el("span", { class: "model", text: entry.model, title: entry.model }),
    // A WebSearch side request is counted apart from the model's own turns; the router marks it.
    entry.purpose === "web-search" ? el("span", { class: "purpose-tag", text: t("logs.webSearch"), title: t("logs.webSearchHelp") }) : null,
    el("span", { class: `provider-badge ${providerClass(entry.provider)}`, text: providerLabel(entry.provider) }),
  ]);
  // The labels show only where a narrow window drops the header row.
  return el("tr", {}, [
    el("td", { class: "c-model" }, [model]),
    el("td", { class: "c-count", "data-label": t("logs.th.count") }, [formatNumber(entry.count)]),
    el("td", { class: "c-in", "data-label": t("logs.th.input") }, [el("span", { class: "token-cell", text: formatNumber(total) }, [el("span", { class: "cache-pill", text: t("logs.cacheHit", { percent: entry.cacheHitPercent || 0 }) })])]),
    el("td", { class: "c-out", "data-label": t("logs.th.output") }, [formatNumber(entry.output)]),
    modelCostCell(entry),
    el("td", { class: "c-dur", "data-label": t("logs.th.avg"), title: rate === null ? undefined : t("logs.modelRateHelp") }, [
      formatSeconds(entry.avgMs),
      rate === null ? null : el("span", { class: "rate-pill", text: t("logs.rateApprox", { value: rateValue(rate) }) }),
    ]),
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
// Below this a request is mostly fixed overhead, and a rate from it is noise.
const OUTPUT_RATE_MIN_MS = 500;
/**
 * Output tokens per second over the request's whole recorded time: the router's `ms` runs from the
 * body read to the response end, so the wait for the first token is in it and this is not the
 * model's generation speed. Only a finished model answer with a real output count gets one: a
 * failure, a resend, an answer refused before reaching a model, a web search (answered in one piece
 * after the search) and an image have none, and neither has an output of 0, which a missing usage
 * also reads as.
 */
function outputRateOf(record) {
  if (!record || record.kind !== "messages" || record.purpose === "web-search" || !record.ok || record.resent || record.upstreamCalled === false) return null;
  const output = record.usage ? record.usage.output : undefined;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return null;
  if (typeof record.ms !== "number" || !Number.isFinite(record.ms) || record.ms < OUTPUT_RATE_MIN_MS) return null;
  return (output * 1000) / record.ms;
}
/**
 * A model row's output rate, approximated from the summary it already has: its output over all its
 * requests' time (`avgMs × count`). That time also holds failed, resent and token-count requests,
 * which bring no output, so a model with long failures reads lower than its answers ran. A web
 * search row has none, as on the request list.
 */
function modelRateOf(entry) {
  if (!entry || entry.purpose === "web-search") return null;
  const { output, avgMs, count } = entry;
  if (![output, avgMs, count].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) return null;
  if (avgMs < OUTPUT_RATE_MIN_MS) return null;
  return (output * 1000) / (avgMs * count);
}
function rateValue(rate) {
  return rate >= 100 ? Math.round(rate).toLocaleString() : rate.toFixed(1);
}
function formatRate(rate) {
  return t("logs.rate", { value: rateValue(rate) });
}
function requestAccount(record) {
  // The current login has a name only when its row snapshotted the email; an older row says just that it was the login.
  if (record.account === "current") return record.accountLabel || t("providers.anthropicCurrent");
  // The same naming as the accounts list (claudeAccountLabel): the router's generic default name is translated.
  if (record.account) return record.accountLabel === "Claude account" ? t("providers.claudeAccountDefault") : record.accountLabel || record.account.slice(0, 8);
  // An API key's label is kept on its row when the request runs; the keys configured now do not decide it.
  return record.credential || "";
}
function requestDetail(record) {
  const details = [
    [t("logs.detail.id"), record.id],
    [t("logs.detail.kind"), record.purpose === "web-search" ? `${record.kind} · ${t("logs.webSearch")}` : record.kind],
    [t("logs.detail.stop"), record.stopReason || t("logs.none")],
    [t("logs.detail.uncached"), record.usage ? formatNumber(record.usage.input) : t("logs.none")],
    [t("logs.detail.cacheRead"), record.usage && record.usage.cached ? formatNumber(record.usage.cached) : t("logs.none")],
    [t("logs.detail.cacheWrite"), record.usage && record.usage.cacheWrite ? formatNumber(record.usage.cacheWrite) : t("logs.none")],
  ];
  const account = requestAccount(record);
  if (account) details.push([t("logs.provider"), providerLabel(record.provider)], [t("logs.detail.account"), account]);
  // Both tiers side by side: the ChatGPT sign-in often serves `default` for a request made on
  // `priority` (#54), so the served tier cannot be the FAST badge's basis; the requested one is.
  if (record.requestedTier || record.servedTier) details.push([t("logs.detail.tier"), `${record.requestedTier || t("logs.none")} / ${record.servedTier || t("logs.none")}`]);
  const cells = details.map(([label, value]) => el("div", {}, [el("span", { class: "detail-label", text: label }), el("span", { class: "detail-value", text: value })]));
  if (record.note) cells.push(el("div", { class: "request-note" }, [el("span", { class: "detail-label", text: t("logs.detail.note") }), el("span", { class: "detail-value", text: record.note })]));
  return el("tr", { class: "request-detail" }, [el("td", { colspan: "7" }, [el("div", { class: "request-detail-grid" }, cells)])]);
}
function requestRow(record) {
  const row = el("tr", { class: "request-row", title: record.note || "", onclick: () => { expandedRequestId = expandedRequestId === record.id ? null : record.id; renderRequests(requestRows); } });
  // The requested name's `@effort` is the agent file's default, not what was sent: a marker can
  // override it, and `gpt-6-sol@medium` beside an effort of high read as a contradiction
  // (2026-09-23). The effort column is the sent value, so the source is shown without it.
  const source = record.source ? record.source.replace(/@[^@]*$/, "") : "";
  const account = requestAccount(record);
  const model = el("div", { class: "request-models" }, [
    el("span", { class: "model", text: record.target }),
    source && source !== record.target ? el("span", { class: "small", text: `(${source})` }) : null,
    record.purpose === "web-search" ? el("span", { class: "purpose-tag", text: t("logs.webSearch"), title: t("logs.webSearchHelp") }) : null,
    // The account says more than the provider's id, which is often an address of its own: the
    // badge keeps the provider's colour and names it on hover and in the detail.
    el("span", { class: `provider-badge ${providerClass(record.provider)}`, text: account || providerLabel(record.provider), ...(account ? { title: providerLabel(record.provider) } : {}) }),
    // The requested tier, not the served one: the ChatGPT sign-in answers `default` to a Fast request (#54).
    record.requestedTier === "priority" ? el("span", { class: "fast-tag", text: "FAST", title: t("logs.fastHelp") }) : null,
  ].filter(Boolean));
  // The whole input, not the uncached remainder: a fully cached Anthropic turn reports `input: 2`,
  // which read as a two-token request (2026-09-23). The split is in the detail row.
  const totalInput = record.usage ? totalInputOf(record.usage) : 0;
  const rate = outputRateOf(record);
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
    el("td", { class: "c-dur", title: rate === null ? undefined : t("logs.rateHelp") }, [
      formatSeconds(record.ms),
      rate === null ? null : el("span", { class: "rate-pill", text: formatRate(rate) }),
    ]),
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
