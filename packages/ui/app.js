"use strict";


function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = Boolean(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children || []) {
    if (child !== null && child !== undefined) node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

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

function modelsOf(provider) {
  const value = (provider && provider.models) || [];
  return value.map((model) => typeof model === "string" ? { id: model, name: model } : model).filter((model) => model && model.id);
}
function labelOf(model) { return model.name || model.id; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeName(value) { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider"; }
function uniqueName(name, providers) {
  const base = safeName(name);
  let value = base;
  let number = 2;
  while (providers[value]) value = `${base}-${number++}`;
  return value;
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
function fallbackEffortLevels(provider, model) {
  if (!provider) return [];
  const explicit = modelEffortLevels(provider, model);
  if (explicit !== undefined) return explicit;
  if (provider.type === "chatgpt") return model === "gpt-5.6-luna" ? ["low", "medium", "high", "xhigh", "max", "ultra"] : ["low", "medium", "high", "xhigh", "max"];
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

function selectOption(value, text) { return el("option", { value }, [text]); }
function badge(kind, text) { return el("span", { class: `badge ${kind} dot`, text }, []); }
function hint(text) { return el("p", { class: "hint", text }, []); }

function showView(name) {
  for (const button of $all(".nav-btn")) button.classList.toggle("active", button.dataset.view === name);
  for (const view of $all(".view")) view.classList.toggle("active", view.id === `view-${name}`);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "slots" && !slotsLoaded) void loadSlots();
  if (name === "providers" && !providersLoaded) void loadProviders();
  if (name === "clients" && !clientsLoaded) void loadClients();
  if (name === "logs") queueMicrotask(() => void refreshRequests());
}
for (const button of $all(".nav-btn")) button.addEventListener("click", () => showView(button.dataset.view));
window.addEventListener("hashchange", () => showView((location.hash || "#health").slice(1)));
showView((location.hash || "#health").slice(1) || "health");

(function setupLanguage() {
  const button = $("#lang-toggle");
  const lang = (typeof CURRENT_LANG !== "undefined" && CURRENT_LANG) || "en";
  button.textContent = lang === "ko" ? t("lang.toggleEn") : t("lang.toggleKo");
  button.addEventListener("click", () => {
    try { localStorage.setItem("clauderipple_lang", lang === "ko" ? "en" : "ko"); } catch { /* unavailable */ }
    location.reload();
  });
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
    $("#health-desktop").replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("health.desktop") }), badge("bad", t("health.disconnected"))]));
    return;
  }
  // Served files changed underneath an open window (e.g. after an update): reload, unless a form is open.
  if (status.uiRevision) {
    if (loadedUiRevision === null) loadedUiRevision = status.uiRevision;
    else if (loadedUiRevision !== status.uiRevision && $("#modal-backdrop").hidden) location.reload();
  }
  const desktop = $("#health-desktop");
  desktop.replaceChildren(
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.connection") }), status.settings.pointsAtRouter ? badge("ok", t("health.connected")) : badge("bad", t("health.notConnected"))]),
    hint(status.settings.pointsAtRouter ? t("health.connectedHelp") : t("health.notConnectedHelp")),
  );
  $("#health-requests").replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("health.requests") }), el("span", { class: "v", text: t("health.requestsFmt", status.stats) })]));
  renderHealthProviders();
  if (clientsLoaded) renderClients();
  const details = $("#health-details");
  details.replaceChildren(
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.version") }), el("span", { class: "v", text: status.version })]),
    // Which files answer, and since when: the only way to see that an update actually replaced the router.
    ...(status.runtime ? [el("div", { class: "row" }, [el("span", { class: "k", text: t("health.runtime") }), el("span", { class: "v", text: `${status.runtime.router || "?"} · ${new Date(status.runtime.startedAt).toLocaleString()}` })])] : []),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.routes") }), el("span", { class: "v", text: String(status.routes) })]),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.cli") }), el("span", { class: "v", text: status.cliVersion })]),
  );
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
async function startChatgptLogin(onChange) {
  if (chatgptLoginBusy) return;
  chatgptLoginBusy = true;
  chatgptLoginMessage = t("providers.chatgptLoginWaiting");
  onChange && onChange();
  try {
    await api("/api/chatgpt-login", { method: "POST" });
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const login = await api("/api/chatgpt-login");
      if (login.signedIn) {
        toast(t("providers.chatgptLoginDone"));
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
    if (c.state === "quarantined") return `${who}: ${t("pool.quarantined")}`;
    if (c.state === "cooling") return `${who}: ${t("pool.cooling", { seconds: c.cooldownSeconds ?? 0 })}`;
    return `${who}: ${t("pool.ready")}`;
  });
  const resting = pool.filter((c) => c.state !== "ready").length;
  return el("div", { class: `small ${resting ? "bad-text" : ""}`.trim(), text: parts.join(" · ") });
}

function providerState(name, provider) {
  const live = status && status.providers && status.providers[name];
  // Reaching the host is not the same as being able to use it. A ChatGPT provider with no
  // credentials would otherwise read "Connected" and send the user off believing it works.
  if (live && live.needsLogin) return badge("warn", t("providerStatus.loginNeeded"));
  const state = stateFor(name);
  // A probe is the better evidence — it actually called the provider — but only while it is fresh.
  // One caught mid-restart used to sit there in red for the rest of the session, while the poll
  // every five seconds said the provider was fine and a fresh probe agreed. After PROBE_TTL_MS the
  // live reading takes over, so a stale failure heals itself instead of needing a manual re-check.
  if (state && !probeIsStale(state)) {
    return state.ok ? badge("ok", t("providerStatus.connected"))
      : state.auth === "bad-key" ? badge("bad", t("providerStatus.keyNeeded"))
      : badge("bad", t("providerStatus.disconnected"));
  }
  if (live) return live.reachable ? badge("ok", t("providerStatus.connected")) : badge("bad", t("providerStatus.disconnected"));
  if (state) return badge("bad", t("providerStatus.disconnected"));
  return badge("warn", t("providerStatus.checking"));
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
    const line = el("div", { class: "provider-status" }, [
      el("strong", { text: name }),
      providerState(name, provider),
      live && live.needsLogin ? chatgptLoginButton(() => renderHealthProviders()) : null,
      live && live.needsLogin && chatgptLoginMessage ? el("span", { class: "small", text: chatgptLoginMessage }) : null,
    ].filter(Boolean));
    const quota = quotaLine(name);
    if (quota) line.appendChild(el("div", { class: "small", text: quota }));
    const pool = credentialLine(name);
    if (pool) line.appendChild(pool);
    return line;
  }));
}

let agentTitleBusy = false;
let codexBusy = false;
function renderClients() {
  if (!currentConfig || !status) return;
  const picker = status.picker || { enabled: false, last: null };
  const last = picker.last || null;
  const names = status.pickerModels || [];
  $("#client-picker-rows").replaceChildren(...[
    el("div", { class: "row" }, [el("span", { class: "k", text: t("picker.state") }), picker.enabled ? badge("ok", t("picker.on")) : el("span", { class: "small", text: t("picker.off") })]),
    picker.enabled ? el("div", { class: "small", text: t("picker.models", { count: names.length, names: names.join(", ") || "—" }) }) : null,
    picker.enabled ? (last && last.at ? el("div", { class: "small", text: t("picker.lastAt", { at: new Date(last.at).toLocaleString() }) }) : hint(t("picker.never"))) : null,
  ].filter(Boolean));
  const pickerButton = $("#client-picker-toggle");
  pickerButton.textContent = picker.enabled ? t("picker.turnOff") : t("picker.turnOn");
  pickerButton.className = picker.enabled ? "btn secondary" : "btn";
  pickerButton.disabled = pickerBusy;
  pickerButton.onclick = () => togglePicker(!picker.enabled);
  renderClientPickerModels(picker.enabled);
  renderModelSlots();
  const agentEnabled = Boolean(status.agentTitle);
  $("#client-agent-title-rows").replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("picker.state") }), agentEnabled ? badge("ok", t("agentTitle.on")) : el("span", { class: "small", text: t("agentTitle.off") })]));
  const agentButton = $("#client-agent-title-toggle");
  agentButton.textContent = agentEnabled ? t("agentTitle.turnOff") : t("agentTitle.turnOn");
  agentButton.className = agentEnabled ? "btn secondary" : "btn";
  agentButton.disabled = agentTitleBusy;
  agentButton.onclick = () => toggleAgentTitle(!agentEnabled);
  void renderCodexClient();
  const mapped = Object.entries(currentConfig.routes || {}).map(([source, route]) => `${labelOf(claudeModels.find((model) => model.id === source) || { id: source })} → ${labelOf((groupedModels(currentConfig).find((group) => group.name === route.provider) || { models: [] }).models.find((model) => model.id === route.model) || { id: route.model })}`);
  $("#client-claude-code-rows").replaceChildren(el("div", { class: "small", text: mapped.join(" · ") || t("slots.noChanges") }));
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
function providerCannotSearch(name) {
  return Boolean(status && status.providers && status.providers[name] && status.providers[name].webSearch !== true);
}

function renderModelSlots() {
  const rows = $("#client-model-slots");
  if (!rows) return;
  const chosen = (currentConfig.cli && currentConfig.cli.models) || {};
  rows.replaceChildren(...MODEL_SLOTS.map((slot) => {
    const select = el("select", {});
    select.appendChild(el("option", { value: "", text: t("slots.slotDefault") }));
    for (const group of groupedModels(currentConfig)) for (const model of group.models) {
      const option = el("option", { value: model.id, text: `${labelOf(model)} · ${group.name}` });
      if (chosen[slot] === model.id) option.selected = true;
      // `smallFast` is what a WebSearch runs on, so an inability to search is fatal there and
      // merely worth knowing everywhere else.
      if (slot === "smallFast" && providerCannotSearch(group.name)) {
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
    return el("div", { class: "slot-row" }, [
      el("span", { class: "k", text: t(`slots.slot.${slot}`) }),
      select,
      el("span", { class: "hint", text: t(`slots.slotHelp.${slot}`) }),
    ]);
  }));
}

async function saveModelSlots() {
  if (!currentConfig) return;
  const next = clone(currentConfig);
  // Every slot is recorded, empty ones included. A select put back to "default (Claude)" has to
  // remove the env key, and the router tells "clear this" from "leave this alone" by whether the
  // slot is present at all — so dropping empty values here would make the choice a silent no-op.
  const models = {};
  for (const select of $all("#client-model-slots select")) models[select.dataset.slot] = select.value;
  next.cli = { ...(next.cli || {}), models };
  try {
    await configRequest(next);
    currentConfig = next;
    // Saying "saved" over a choice that will make every search fail is the same silent no-op this
    // screen was already guilty of once. The label on the option warns before the fact; this catches
    // a session that already had it selected.
    const owners = models.smallFast ? providersOffering(next, models.smallFast) : [];
    if (owners.length && providerCannotSearch(owners[0])) toast(t("slots.noWebSearchWarn"), true);
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
  const next = applyPickerSelections(clone(currentConfig), clientPickerSelections());
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
async function toggleAgentTitle(enabled) {
  if (agentTitleBusy) return;
  agentTitleBusy = true;
  try {
    await api("/api/agent-title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    toast(t("common.saved"));
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    agentTitleBusy = false;
    void refreshHealth();
  }
}
async function renderCodexClient() {
  const rows = $("#client-codex-rows");
  const button = $("#client-codex-toggle");
  try {
    const codex = await api("/api/codex");
    rows.replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("picker.state") }), codex.enabled ? badge("ok", t("picker.on")) : el("span", { class: "small", text: t("picker.off") })]), el("div", { class: "small", text: codex.configPath }));
    button.textContent = codex.enabled ? t("clients.codex.turnOff") : t("clients.codex.turnOn");
    button.className = codex.enabled ? "btn secondary" : "btn";
    button.disabled = codexBusy;
    button.onclick = () => toggleCodex(!codex.enabled);
  } catch (error) {
    rows.replaceChildren(el("div", { class: "small bad-text", text: error.message }));
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
function slotRow(id, route) {
  const row = el("tr", {});
  const source = claudeSelect(id);
  const target = targetSelect(route);
  const initialTarget = routeFromTarget(target.value);
  const effort = effortSelect(route && route.effort, initialTarget ? effortLevelsFor(initialTarget.provider, initialTarget.model) : ["high"]);
  const effortCell = el("td", {}, [effort]);
  const remove = el("button", { class: "icon-btn", type: "button", title: t("common.remove"), text: "×", onclick: () => { row.remove(); updateSlotSummary(); scheduleSlotsSave(); } });
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
  row.append(el("td", {}, [source]), el("td", {}, [target]), effortCell, el("td", { class: "icon-cell" }, [remove]));
  row._get = () => ({ id: source.value, route: routeFromTarget(target.value), effort: effort.value });
  sync();
  return row;
}
async function loadSlots() {
  slotsLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    const rows = $("#slots-table tbody");
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
  $("#slots-table tbody").appendChild(slotRow(claudeModels[0].id, null));
  updateSlotSummary();
});
function allKnownModelIds(config) { return new Set(groupedModels(config).flatMap((group) => group.models.map((model) => model.id))); }
// Which providers carry this exact id. One is what lets the router route it with no rule at all;
// two is the ambiguity it refuses to guess through, and the only case a rule is still needed.
function providersOffering(config, id) { return groupedModels(config).filter((group) => group.models.some((model) => model.id === id)).map((group) => group.name); }
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
  const summaries = $all("#slots-table tbody tr").map((row) => row._get()).filter((item) => item.route).slice(0, 3).map((item) => {
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
  const next = clone(currentConfig);
  const routes = {};
  const seen = new Set();
  for (const row of $all("#slots-table tbody tr")) {
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

function statusText(state) {
  if (!state) return t("providerStatus.checking");
  if (state.ok) return t("providerStatus.connected");
  if (state.auth === "bad-key") return t("providerStatus.keyNeeded");
  return t("providerStatus.disconnected");
}
async function probeProvider(name, provider, onComplete) {
  probeStates.set(name, { pending: true });
  renderHealthProviders();
  try {
    const headers = provider.headers || {};
    const body = provider.type === "anthropic"
      ? { type: "anthropic", auth: provider.auth, ...(provider.auth === "api-key" && provider.apiKey ? { apiKey: provider.apiKey } : {}) }
      : {
        type: provider.type,
        url: provider.url,
        headers,
        modelsUrl: provider.modelsUrl || (provider.preset && presetById(provider.preset) && presetById(provider.preset).modelsUrl),
        modelsAuthHeader: provider.modelsAuthHeader || (provider.preset && presetById(provider.preset) && presetById(provider.preset).modelsAuthHeader),
        // The router reads the preset's fallback list to tag each discovered model with the wire it
        // speaks, since /models reports ids alone and one plan can serve several wires.
        preset: provider.preset,
        probeModel: provider.probeModel || (provider.preset && presetById(provider.preset) && (presetById(provider.preset).fallbackModels || [])[0] && presetById(provider.preset).fallbackModels[0].id),
        // Some vendors refuse a request without it rather than merely losing the cache, so a test
        // that leaves it out reports a broken provider that works perfectly.
        sessionHeader: provider.sessionHeader || (provider.preset && presetById(provider.preset) && presetById(provider.preset).sessionHeader),
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
let selectedProviderName = null;
let providerDetailTab = "overview";
let providerSearch = "";
let providerDetailGeneration = 0;

function providerKind(name, provider) {
  const preset = provider.preset && presetById(provider.preset);
  if (provider.type === "chatgpt") return t("providers.chatgpt");
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
  button.addEventListener("click", () => {
    selectedProviderName = name;
    providerDetailTab = provider.type === "anthropic" && provider.auth === "claude-code" ? "accounts" : "overview";
    renderProviderWorkspace();
  });
  return button;
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
  const next = clone(currentConfig);
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
    renderProviderWorkspace();
    toast(t("common.saved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

function providerTabs(name, provider) {
  const tabs = [{ id: "overview", label: t("providers.overview") }];
  if (provider.type === "anthropic" && provider.auth === "claude-code") tabs.push({ id: "accounts", label: t("providers.accounts") });
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
  const connection = el("section", { class: "detail-section" }, [
    el("h3", { text: t("providers.connection") }),
    el("div", { class: "detail-setting-row" }, [
      el("div", { class: "setting-copy" }, [el("strong", { text: statusText(state) }), el("span", { text: providerKind(name, provider) })]),
      providerState(name, provider),
    ]),
    state && !state.ok && state.error ? el("p", { class: "bad-text small provider-detail-error", text: shortError(state.error), title: state.error }) : null,
    live && live.needsLogin ? chatgptLoginButton(renderProviderDetail) : null,
  ].filter(Boolean));
  const models = modelsOf(provider);
  const modelSummary = el("section", { class: "detail-section" }, [
    el("h3", { text: t("providers.selectedModels") }),
    models.length ? el("div", { class: "model-chip-list" }, models.map((model) => el("span", { class: "model-chip", text: labelOf(model) }))) : hint(t("providers.noModels")),
  ]);
  const quota = quotaLine(name);
  return el("div", { class: "provider-panel" }, [connection, quota ? el("section", { class: "detail-section" }, [el("h3", { text: t("health.quota", { percent: "", reset: "" }).trim() }), el("p", { text: quota })]) : null, modelSummary].filter(Boolean));
}

function providerModelsPanel(name, provider) {
  const models = modelsOf(provider);
  return el("div", { class: "provider-panel" }, [
    el("section", { class: "detail-section" }, [
      el("div", { class: "section-heading" }, [el("div", {}, [el("h3", { text: t("providers.selectedModels") }), hint(t("providers.modelsHelp"))]), el("button", { class: "btn secondary", type: "button", text: t("common.edit"), onclick: () => openProviderForm({ name, provider }) })]),
      models.length ? el("div", { class: "provider-model-list" }, models.map((model) => el("div", { class: "provider-model-row" }, [el("strong", { text: labelOf(model) }), el("span", { class: "small", text: model.id }), modelEffortTag(model) ? el("span", { class: `model-effort-tag ${model.effortLevels.length ? "has-effort" : "no-effort"}`, text: modelEffortTag(model) }) : null].filter(Boolean)))) : hint(t("providers.noModels")),
    ]),
  ]);
}

async function saveAnthropicRotation(name, provider, enabled, control, message) {
  control.disabled = true;
  message.textContent = t("providers.rotationSaving");
  const next = clone(currentConfig);
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

function renderClaudeAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  const rows = [];
  if (data.current) rows.push(el("article", { class: "account-card current" }, [
    el("div", { class: "account-card-copy" }, [el("strong", { text: data.current.label }), el("span", { class: "small", text: anthropicSourceText(data.current.source) }), hint(t("providers.currentAccountHelp"))]),
    el("span", { class: "badge ok", text: t("providers.anthropicCurrent") }),
  ]));
  for (const account of Array.isArray(data.accounts) ? data.accounts : []) {
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
    if (unavailable) {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => openClaudeAccountConsent(name));
      actions.unshift(reauth);
    }
    rows.push(el("article", { class: "account-card" }, [
      el("div", { class: "account-card-copy" }, [el("strong", { text: account.label }), account.email && account.email !== account.label ? el("span", { class: "small", text: account.email }) : null, hint(t("providers.addedAccountHelp"))]),
      el("span", { class: `badge ${unavailable ? "bad" : "ok"}`, text: unavailable ? t("providers.anthropicReauth") : t("pool.ready") }),
      el("div", { class: "account-card-actions" }, actions),
    ]));
  }
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "empty-card", text: t("providers.anthropicNoAccounts") })]));
  const count = (data.current ? 1 : 0) + (Array.isArray(data.accounts) ? data.accounts.length : 0);
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
  const add = el("button", { class: "btn", type: "button", text: t("providers.addClaudeAccount") });
  add.addEventListener("click", () => openClaudeAccountConsent(name));
  const removeAll = el("button", { class: "btn danger", type: "button", text: t("providers.anthropicLogoutAll") });
  removeAll.addEventListener("click", async () => {
    if (!confirm(t("providers.anthropicLogoutAllConfirm"))) return;
    try { await api("/api/claude-logout", { method: "POST" }); await refreshClaudeAccountPanel(name); }
    catch (error) { toast(t("common.actionFailed"), true, error.message); }
  });
  const rows = el("div", { id: "claude-account-rows", class: "account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "detail-section account-summary" }, [
      el("div", { class: "section-heading" }, [el("div", {}, [el("h3", { text: t("providers.accountPoolTitle") }), el("p", { id: "claude-account-count", class: "account-count", text: t("providers.accountCount", { count: 0 }) }), hint(t("providers.accountCountHelp"))]), add]),
      el("div", { class: "detail-setting-row rotation-row" }, [el("div", { class: "setting-copy" }, [el("strong", { text: t("providers.anthropicPool") }), el("span", { text: t("providers.accountPoolSubtitle") })]), el("label", { class: "switch" }, [rotation, el("span")])]),
      !provider.accountPool ? el("div", { class: "notice warn" }, [el("strong", { text: t("providers.rotationOff") }), el("span", { text: t("providers.rotationRequired") })]) : null,
      rotationMessage,
    ]),
    el("section", { class: "detail-section" }, [rows]),
    el("section", { class: "detail-section danger-section" }, [el("h3", { text: t("providers.dangerZone") }), hint(t("providers.anthropicLogoutAllConfirm")), removeAll]),
  ]);
  queueMicrotask(() => void refreshClaudeAccountPanel(name));
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
  const remove = el("button", { class: "btn danger", type: "button", text: t("common.remove"), onclick: () => void removeProvider(name, provider) });
  const header = el("header", { class: "provider-detail-header" }, [
    el("div", {}, [el("div", { class: "provider-title-line" }, [el("h2", { text: name }), providerState(name, provider)]), el("p", { class: "small", text: providerKind(name, provider) })]),
    el("div", { class: "provider-detail-actions" }, [check, edit, remove]),
  ]);
  let content;
  if (providerDetailTab === "accounts" && provider.type === "anthropic" && provider.auth === "claude-code") content = anthropicAccountsPanel(name, provider);
  else if (providerDetailTab === "models") content = providerModelsPanel(name, provider);
  else { providerDetailTab = "overview"; content = providerOverview(name, provider); }
  detail.replaceChildren(header, providerTabs(name, provider), content);
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
    currentConfig = currentConfig || await api("/api/config");
    if (!status) status = await api("/api/status");
    renderClients();
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}

async function loadProviders() {
  providersLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = currentConfig || await api("/api/config");
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

function openProviderChooser() {
  const grid = el("div", { class: "chooser-grid" });
  const anthropic = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: t("providers.anthropic") }), el("span", { text: t("providers.anthropicHelp") })]);
  anthropic.addEventListener("click", () => openProviderForm({ kind: "anthropic" }));
  grid.appendChild(anthropic);
  const chatgpt = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: t("providers.chatgpt") }), el("span", { text: t("providers.chatgptHelp") })]);
  chatgpt.addEventListener("click", () => openProviderForm({ kind: "chatgpt" }));
  grid.appendChild(chatgpt);
  const native = presets.filter((preset) => (preset.kind || "anthropic-compatible") === "anthropic-compatible");
  for (const preset of native) {
    const tile = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: preset.name }), el("span", { text: t("providers.presetHelp") })]);
    tile.addEventListener("click", () => openProviderForm({ preset }));
    grid.appendChild(tile);
  }
  const openai = presets.filter((preset) => preset.kind === "openai-compatible");
  if (openai.length) {
    grid.appendChild(el("div", { class: "chooser-group" }, [el("strong", { text: t("providers.openaiGroup") }), el("span", { text: t("providers.openaiGroupHelp") })]));
    for (const preset of openai) {
      const tile = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: preset.name }), el("span", { text: t("providers.presetHelp") })]);
      tile.addEventListener("click", () => openProviderForm({ preset }));
      grid.appendChild(tile);
    }
  }
  const custom = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: t("providers.custom") }), el("span", { text: t("providers.customHelp") })]);
  custom.addEventListener("click", () => openProviderForm({ kind: "custom" }));
  grid.appendChild(custom);
  showModal(el("div", {}, [el("h1", { id: "modal-title", text: t("providers.choose") }), hint(t("providers.chooseHelp")), grid]));
}
function inputRow(label, control, helpText) {
  return el("label", { class: "form-field" }, [el("span", { text: label }), control, helpText ? el("small", { text: helpText }) : null]);
}
// Checklist that stays usable with hundreds of models (OpenRouter lists 400+): a search box, checked
// entries pinned first, at most 36 visible rows, and the selection kept in a Set so filtering never
// loses ticks. `box.selected()` returns the chosen entries, each carrying whatever per-model override
// it arrived with (effortLevels, and the wire/url/authHeader a preset gave it) so a save does not
// strip the endpoint the model speaks.
function modelOverrideFields(model) {
  return {
    ...(Array.isArray(model.effortLevels) ? { effortLevels: [...model.effortLevels] } : {}),
    ...(model.wire ? { wire: model.wire } : {}),
    ...(model.url ? { url: model.url } : {}),
    ...(model.authHeader ? { authHeader: model.authHeader } : {}),
  };
}
function modelChecklist(models, checked) {
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
  let selected = new Set(modelsOf(existing).length ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
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
        el("span", { class: response.ok && !noCredits ? "ok-text" : noCredits ? "warn-text" : "bad-text", text: noCredits ? t("providers.probeNoCredits") : response.ok ? t("providers.probeOk") : response.auth === "bad-key" ? t("providers.probeBadKey") : auth.value === "claude-code" ? anthropicSourceText(response.source) : t("providers.probeFailed") }),
        response.error ? el("div", { class: "small", text: response.error.replace(/^no-credits:\s*/, "") }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        foundModels = response.models;
        selected = new Set(modelsOf(existing).length ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
        renderModels();
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  const modeHint = hint("");
  function syncModeHint() { modeHint.textContent = auth.value === "claude-code" && accountPool ? t("providers.anthropicPoolRouting") : t("providers.anthropicIngressOnly"); }
  auth.addEventListener("change", syncModeHint);
  syncModeHint();
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")), authField, keyField, probeButton, sourceLine, result, modelArea,
    modeHint,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(currentConfig);
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const checkedModels = form.querySelector(".model-picker").selected();
    const provider = { type: "anthropic", auth: auth.value, ...(auth.value === "claude-code" && accountPool ? { accountPool: true } : {}), ...(auth.value === "api-key" && (keyInput.value || (existing && existing.apiKey)) ? { apiKey: keyInput.value || existing.apiKey } : {}), models: checkedModels };
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
function openProviderForm(options) {
  const existing = options.provider;
  const preset = options.preset || (existing && existing.preset && presetById(existing.preset));
  const isChatgpt = options.kind === "chatgpt" || (existing && existing.type === "chatgpt");
  const isAnthropic = options.kind === "anthropic" || (existing && existing.type === "anthropic");
  const isOpenAi = !isChatgpt && !isAnthropic && ((existing && existing.type === "openai-compatible") || (preset && preset.kind === "openai-compatible"));
  const isCustom = options.kind === "custom";
  const displayName = options.name || (preset && preset.name) || (isChatgpt ? t("providers.chatgpt") : isAnthropic ? t("providers.anthropic") : t("providers.customName"));
  if (isAnthropic) { openAnthropicProviderForm(options); return; }
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const currentHeaders = (existing && existing.headers) || {};
  const headerKind = preset ? preset.authHeader : (isOpenAi || Object.keys(currentHeaders).some((key) => key.toLowerCase() === "authorization") ? "authorization-bearer" : "x-api-key");
  const existingKey = headerKind === "authorization-bearer" ? String(currentHeaders.authorization || "").replace(/^Bearer\s+/i, "") : currentHeaders["x-api-key"] || "";
  if (existingKey) keyInput.placeholder = t("providers.keySaved");
  const urlInput = el("input", { value: (existing && existing.url) || (preset && preset.anthropicBaseUrl) || "", placeholder: "https://" });
  const wireSelect = el("select", {}, [selectOption("chat", "Chat Completions"), selectOption("responses", "Responses")]);
  wireSelect.value = (existing && existing.wire) || (preset && preset.wire) || "chat";
  const pickerInput = el("input", { type: "checkbox", checked: Boolean(existing && (existing.models || []).some((model) => {
    const id = typeof model === "string" ? model : model.id;
    return ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === id);
  })) });
  const initialModels = modelsOf(existing).length ? modelsOf(existing) : (preset ? (preset.fallbackModels || []) : (isChatgpt ? CHATGPT_MODELS : []));
  let foundModels = initialModels;
  const currentChecked = new Set(modelsOf(existing).map((model) => model.id));
  const modelsBox = modelChecklist(foundModels, currentChecked.size ? currentChecked : new Set(foundModels.map((model) => model.id)));
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
    advancedContent.appendChild(inputRow(t("providers.url"), urlInput, isOpenAi ? t("providers.openaiUrlHelp") : t("providers.urlHelp")));
    if (isOpenAi) advancedContent.appendChild(inputRow(t("providers.wire"), wireSelect, t("providers.wireHelp")));
    if (isCustom) {
      const authSelect = el("select", {}, [selectOption("x-api-key", "x-api-key"), selectOption("authorization-bearer", "Authorization: Bearer")]);
      authSelect.value = headerKind;
      advancedContent.appendChild(inputRow(t("providers.keyType"), authSelect, t("providers.keyTypeHelp")));
      authSelect.addEventListener("change", () => { keyInput.dataset.headerKind = authSelect.value; });
    }
    const extraHeaders = el("textarea", { rows: "2", placeholder: "header-name: value" });
    const additional = Object.entries(currentHeaders).filter(([key]) => key.toLowerCase() !== "x-api-key" && key.toLowerCase() !== "authorization");
    extraHeaders.value = additional.map(([key, value]) => `${key}: ${value}`).join("\n");
    advancedContent.appendChild(inputRow(t("providers.extraHeaders"), extraHeaders, t("providers.extraHeadersHelp")));
    advancedContent._extraHeaders = extraHeaders;
    // Without a line of its own the model reads Claude Code's system prompt and answers that it is
    // Claude, which is what DeepSeek did before this was offered here too.
    const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    advancedContent.append(
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
      inputRow(t("providers.append"), append, t("providers.appendHelp")),
    );
    advancedContent._prompt = { identity, append };
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
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    chatgptFields = [
      inputRow(t("providers.credentials"), auth, t("providers.credentialsHelp")),
      el("div", { class: "form-field" }, [el("span", { text: t("providers.login") }), login, loginHelp]),
      inputRow(t("providers.defaultEffort"), effort, t("providers.defaultEffortHelp")),
    ];
    advancedContent.append(
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
      inputRow(t("providers.append"), append, t("providers.appendHelp")),
    );
    advancedContent._chatgpt = { auth, effort, identity, append };
  }
  advanced.appendChild(advancedContent);
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")),
    !isChatgpt ? el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.keyHelp") })]) : null,
    isCustom ? inputRow(t("providers.url"), urlInput, t("providers.urlHelp")) : null,
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
      if (kind === "authorization-bearer") headers.authorization = currentHeaders.authorization;
      else headers["x-api-key"] = currentHeaders["x-api-key"];
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
      return { type: "chatgpt", auth: chat.auth.value, defaultEffort: chat.effort.value, identity: chat.identity.checked, ...(chat.append.value.trim() ? { instructionsAppend: chat.append.value.trim() } : {}) };
    }
    const prompt = advancedContent._prompt;
    return {
      type: isOpenAi ? "openai-compatible" : "anthropic-compatible",
      url: urlInput.value.trim(),
      ...(prompt ? { identity: prompt.identity.checked } : {}),
      ...(prompt && prompt.append.value.trim() ? { instructionsAppend: prompt.append.value.trim() } : {}),
      ...(preset ? { preset: preset.id } : {}),
      // A vendor that asks for a session header keys its prompt cache on it, so carry it from the
      // preset rather than leaving the user to discover the bill.
      ...(preset && preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
      ...(isOpenAi ? { wire: wireSelect.value, caps: { effortLevels: (preset && preset.effortLevels) || [], reasoning: preset && preset.effortLevels && preset.effortLevels.length ? "effort" : "none" } } : {}),
      ...(Object.keys(readHeaders()).length ? { headers: readHeaders() } : {}),
    };
  }
  function probeDraft() {
    const d = draftProvider();
    if (preset) { d.modelsUrl = preset.modelsUrl; d.modelsAuthHeader = preset.modelsAuthHeader; d.probeModel = (preset.fallbackModels || [])[0] && preset.fallbackModels[0].id; }
    return d;
  }
  async function runProbe() {
    const draft = probeDraft();
    if (!draft.url || !/^https?:\/\//.test(draft.url)) { toast(t("providers.urlRequired"), true); return; }
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    const temporary = `__new_${Date.now()}`;
    const response = await probeProvider(temporary, draft);
    probeButton.disabled = false;
    const noCredits = response.ok && /^no-credits:/.test(response.error || "");
    const headline = noCredits ? t("providers.probeNoCredits") : response.ok ? t("providers.probeOk") : response.auth === "bad-key" ? t("providers.probeBadKey") : response.unavailable ? t("providers.apiSoon") : t("providers.probeFailed");
    result.replaceChildren(...[
      el("span", { class: response.ok && !noCredits ? "ok-text" : noCredits ? "warn-text" : "bad-text", text: headline }),
      response.error ? el("div", { class: "small", text: response.error.replace(/^no-credits:\s*/, "") }) : null,
    ].filter(Boolean));
    foundModels = response.models && response.models.length ? response.models.map((model) => typeof model === "string" ? { id: model, name: model } : model) : (preset ? (preset.fallbackModels || []) : foundModels);
    const keep = foundModels.length > 12 ? new Set([...currentChecked, ...modelArea.querySelector(".model-picker").selected().map((m) => m.id)]) : new Set(foundModels.map((model) => model.id));
    // Saved picks that the provider no longer lists stay visible and ticked so nothing is dropped silently.
    for (const saved of modelsOf(existing)) if (keep.has(saved.id) && !foundModels.some((m) => m.id === saved.id)) foundModels = [saved, ...foundModels];
    modelArea.querySelector(".model-picker").replaceWith(modelChecklist(foundModels, keep));
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(response.ok ? (foundModels.length > 12 ? t("providers.modelsFoundMany") : t("providers.modelsFound")) : t("providers.modelsFallback")), modelArea.querySelector(".model-picker") || document.createTextNode(""));
  }
  probeButton && probeButton.addEventListener("click", runProbe);
  // Editing a provider that can list models: fetch the full list right away so the saved picks are
  // shown among everything available, not as a two-entry list.
  if (existing && !isChatgpt && preset && preset.modelsUrl && existingKey) setTimeout(() => void runProbe(), 0);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const provider = draftProvider();
    if (!isChatgpt && (!provider.url || !/^https?:\/\//.test(provider.url))) { toast(t("providers.urlRequired"), true); return; }
    const next = clone(currentConfig);
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    if (existing && providerName !== options.name) delete next.providers[options.name];
    const checkedModels = form.querySelector(".model-picker").selected();
    provider.models = checkedModels;
    next.providers[providerName] = provider;
    const existingSelections = ((next.cli && next.cli.extraModels) || []).filter((entry) => entry.model !== null && entry.model !== undefined).map((entry) => {
      const direct = (next.direct || []).filter((rule) => entry.model.startsWith(rule.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
      return { id: entry.model, name: entry.name, provider: direct && direct.provider };
    }).filter((entry) => entry.provider && entry.provider !== options.name);
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
    } catch (error) {
      toast(t("common.saveFailed"), true, error.message);
    } finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form);
}

// ---- Logs ---------------------------------------------------------------------------

let logsPanel = "requests";
let requestRows = [];
let knownRequestProviders = new Set();
let requestProvider = "";
let showCountTokens = false;
let expandedRequestId = null;

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
function summaryChip(label, value) { return el("div", { class: "logs-chip" }, [el("span", { class: "label", text: label }), el("span", { class: "value", text: value })]); }

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
$("#logs-provider").addEventListener("change", (event) => { requestProvider = event.target.value; void refreshRequests(); });

function renderSummary(summary) {
  const total = summary && summary.total || { count: 0, ok: 0, failed: 0, input: 0, cached: 0, output: 0, avgMs: 0, cacheHitPercent: 0 };
  $("#logs-summary").replaceChildren(
    summaryChip(t("logs.summary.requests"), formatNumber(total.count)),
    summaryChip(t("logs.summary.success"), `${formatNumber(total.ok)} / ${formatNumber(total.failed)}`),
    summaryChip(t("logs.summary.input"), `${formatNumber(total.input)} · ${t("logs.cacheHit", { percent: total.cacheHitPercent || 0 })}`),
    summaryChip(t("logs.summary.output"), formatNumber(total.output)),
    summaryChip(t("logs.summary.duration"), formatSeconds(total.avgMs)),
  );
}
function renderProviderFilter(records) {
  const select = $("#logs-provider");
  for (const record of records) if (record.provider) knownRequestProviders.add(record.provider);
  const names = [...knownRequestProviders].sort();
  const before = select.value;
  select.replaceChildren(el("option", { value: "", text: t("logs.all") }));
  for (const name of names) select.appendChild(el("option", { value: name, text: name }));
  select.value = names.includes(requestProvider) ? requestProvider : "";
  if (!names.includes(requestProvider)) requestProvider = "";
  if (before && before !== select.value) select.value = requestProvider;
}
function requestDetail(record) {
  const details = [
    [t("logs.detail.id"), record.id],
    [t("logs.detail.kind"), record.kind],
    [t("logs.detail.stop"), record.stopReason || t("logs.none")],
    [t("logs.detail.cacheWrite"), record.usage && record.usage.cacheWrite ? formatNumber(record.usage.cacheWrite) : t("logs.none")],
  ].map(([label, value]) => el("div", {}, [el("span", { class: "detail-label", text: label }), el("span", { class: "detail-value", text: value })]));
  if (record.note) details.push(el("div", { class: "request-note" }, [el("span", { class: "detail-label", text: t("logs.detail.note") }), el("span", { class: "detail-value", text: record.note })]));
  return el("tr", { class: "request-detail" }, [el("td", { colspan: "7" }, [el("div", { class: "request-detail-grid" }, details)])]);
}
function requestRow(record) {
  const row = el("tr", { class: "request-row", title: record.note || "", onclick: () => { expandedRequestId = expandedRequestId === record.id ? null : record.id; renderRequests(requestRows); } });
  const model = el("div", { class: "request-models" }, [
    el("span", { class: "model", text: record.target }),
    record.source && record.source !== record.target ? el("span", { class: "small", text: `(${record.source})` }) : null,
    el("span", { class: `provider-badge ${providerClass(record.provider)}`, text: record.provider }),
  ].filter(Boolean));
  const input = record.usage
    ? el("span", { class: "token-cell", text: formatNumber(record.usage.input) }, [el("span", { class: "cache-pill", text: t("logs.cacheHit", { percent: Math.round(record.usage.cached / Math.max(1, record.usage.input + record.usage.cached) * 100) }) })])
    : el("span", { class: "no-usage", text: t("common.notAvailable") });
  const status = el("span", { class: `status-text ${record.ok ? "ok" : "bad"}`, text: `${record.ok ? t("logs.status.ok") : t("logs.status.error")} ${record.status}` });
  row.append(
    el("td", { text: timeOf(record.at) }),
    el("td", {}, [model]),
    el("td", { text: record.effort || t("common.notAvailable") }),
    el("td", {}, [input]),
    el("td", { class: record.usage ? "" : "no-usage", text: record.usage ? formatNumber(record.usage.output) : t("common.notAvailable") }),
    el("td", { text: formatSeconds(record.ms) }),
    el("td", {}, [status]),
  );
  return row;
}
function renderRequests(records) {
  const scroll = $(".logs-table-card");
  const left = scroll.scrollLeft;
  const tbody = $("#requests-table tbody");
  tbody.replaceChildren(...records.flatMap((record) => expandedRequestId === record.id ? [requestRow(record), requestDetail(record)] : [requestRow(record)]));
  $("#requests-table").closest(".logs-table-card").hidden = records.length === 0;
  $("#requests-empty").hidden = records.length !== 0;
  scroll.scrollLeft = left;
}
async function refreshRequests() {
  if (logsPanel !== "requests") return;
  try {
    const suffix = requestProvider ? `&provider=${encodeURIComponent(requestProvider)}` : "";
    const kind = "&kind=messages";
    const [records, summary, allRecords] = await Promise.all([api(`/api/requests?n=200${suffix}${kind}`), api("/api/requests/summary?since=3600"), api("/api/requests?n=200")]);
    requestRows = Array.isArray(records.requests) ? records.requests : [];
    renderProviderFilter(Array.isArray(allRecords.requests) ? allRecords.requests : requestRows);
    renderSummary(summary);
    renderRequests(requestRows);
  } catch { /* preserve the last successful request table */ }
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
