"use strict";

if (/Electron/i.test(navigator.userAgent)) document.body.classList.add("electron");

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

function configRequest(next) {
  return api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
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
    let models = modelsOf(provider);
    if (!models.length && provider.type === "chatgpt") models = CHATGPT_MODELS;
    if (models.length) groups.push({ name, provider, models });
  }
  return groups;
}
function presetById(id) { return presets.find((preset) => preset.id === id); }
function fallbackEffortLevels(provider, model) {
  if (!provider) return [];
  if (provider.type === "chatgpt") return model === "gpt-5.6-luna" ? ["low", "medium", "high", "xhigh", "max", "ultra"] : ["low", "medium", "high", "xhigh", "max"];
  const preset = provider.preset && presetById(provider.preset);
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

let currentConfig = null;
let status = null;
let loadedUiRevision = null;
let claudeModels = FALLBACK_CLAUDE_MODELS;
let presets = FALLBACK_PRESETS;
let effortCatalog = null;
let slotsLoaded = false;
let providersLoaded = false;
let pickerBusy = false;
let probeStates = new Map();

function selectOption(value, text) { return el("option", { value }, [text]); }
function badge(kind, text) { return el("span", { class: `badge ${kind} dot`, text }, []); }
function hint(text) { return el("p", { class: "hint", text }, []); }

function showView(name) {
  for (const button of $all(".nav-btn")) button.classList.toggle("active", button.dataset.view === name);
  for (const view of $all(".view")) view.classList.toggle("active", view.id === `view-${name}`);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "slots" && !slotsLoaded) void loadSlots();
  if (name === "providers" && !providersLoaded) void loadProviders();
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
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.requests") }), el("span", { class: "v", text: t("health.requestsFmt", status.stats) })]),
  );
  renderHealthProviders();
  renderPicker(status.picker || { enabled: false, last: null });
  renderAgentTitle(Boolean(status.agentTitle));
  const details = $("#health-details");
  details.replaceChildren(
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.version") }), el("span", { class: "v", text: status.version })]),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.routes") }), el("span", { class: "v", text: String(status.routes) })]),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.cli") }), el("span", { class: "v", text: status.cliVersion })]),
  );
}

function quotaLine(name) {
  const quota = status && status.chatgpt && status.chatgpt.quota && status.chatgpt.quota[name];
  const primary = quota && quota.rate_limits && quota.rate_limits.primary;
  if (!primary) return null;
  const reset = primary.reset_after_seconds ? t("health.resetsIn", { hours: Math.max(1, Math.round(primary.reset_after_seconds / 3600)) }) : "";
  return t("health.quota", { percent: primary.used_percent, reset });
}
function stateFor(name) { return probeStates.get(name); }
function providerState(name, provider) {
  const state = stateFor(name);
  if (state) return state.ok ? badge("ok", t("providerStatus.connected")) : state.auth === "bad-key" ? badge("bad", t("providerStatus.keyNeeded")) : badge("bad", t("providerStatus.disconnected"));
  if (status && status.providers && status.providers[name]) return status.providers[name].reachable ? badge("ok", t("providerStatus.connected")) : badge("bad", t("providerStatus.disconnected"));
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
    const line = el("div", { class: "provider-status" }, [el("strong", { text: name }), providerState(name, provider)]);
    const quota = quotaLine(name);
    if (quota) line.appendChild(el("div", { class: "small", text: quota }));
    return line;
  }));
}

function renderPicker(picker) {
  const rows = $("#picker-rows");
  const last = picker.last || null;
  const names = (status && status.pickerModels) || [];
  rows.replaceChildren(...[
    el("div", { class: "row" }, [el("span", { class: "k", text: t("picker.state") }), picker.enabled ? badge("ok", t("picker.on")) : el("span", { class: "small", text: t("picker.off") })]),
    picker.enabled ? el("div", { class: "small", text: t("picker.models", { count: names.length, names: names.join(", ") || "—" }) }) : null,
    picker.enabled ? (last && last.at ? el("div", { class: "small", text: t("picker.lastAt", { at: new Date(last.at).toLocaleString() }) }) : hint(t("picker.never"))) : null,
  ].filter(Boolean));
  const button = $("#picker-toggle");
  button.textContent = picker.enabled ? t("picker.turnOff") : t("picker.turnOn");
  button.className = picker.enabled ? "btn secondary" : "btn";
  button.disabled = pickerBusy;
  button.onclick = () => togglePicker(!picker.enabled, null);
}
let agentTitleBusy = false;
function renderAgentTitle(enabled) {
  $("#agent-title-rows").replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("picker.state") }), enabled ? badge("ok", t("agentTitle.on")) : el("span", { class: "small", text: t("agentTitle.off") })]));
  const button = $("#agent-title-toggle");
  button.textContent = enabled ? t("agentTitle.turnOff") : t("agentTitle.turnOn");
  button.className = enabled ? "btn secondary" : "btn";
  button.disabled = agentTitleBusy;
  button.onclick = async () => {
    if (agentTitleBusy) return;
    agentTitleBusy = true;
    button.disabled = true;
    try {
      await api("/api/agent-title", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      toast(t("common.saved"));
    } catch (error) {
      toast(t("common.actionFailed"), true, error.message);
    } finally {
      agentTitleBusy = false;
      void refreshHealth();
    }
  };
}
async function togglePicker(enabled, checkbox) {
  if (pickerBusy) return;
  if (enabled && !confirm(t("picker.confirmOn"))) {
    if (checkbox) checkbox.checked = false;
    return;
  }
  pickerBusy = true;
  if (checkbox) checkbox.disabled = true;
  $("#picker-msg").textContent = t("picker.working");
  try {
    await api("/api/picker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    toast(enabled ? t("picker.doneOn") : t("picker.doneOff"));
    if (currentConfig) {
      currentConfig.picker = { ...(currentConfig.picker || {}), enabled };
      renderSlotsPicker();
    }
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
    if (checkbox) checkbox.checked = !enabled;
  } finally {
    pickerBusy = false;
    if (checkbox) checkbox.disabled = false;
    $("#picker-msg").textContent = "";
    void refreshHealth();
  }
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
    renderSlotsPicker();
    updateSlotSummary();
  } catch (error) {
    toast(t("common.loadFailed"), true, error.message);
  }
}
function selectedPickerModels() {
  const configured = new Set(((currentConfig.cli && currentConfig.cli.extraModels) || []).map((entry) => entry.model));
  return $all("#picker-models input[type=checkbox]").length
    ? $all("#picker-models input[type=checkbox]").filter((input) => input.checked).map((input) => input.dataset.model)
    : [...configured];
}
function renderSlotsPicker() {
  const enabled = Boolean(currentConfig && currentConfig.picker && currentConfig.picker.enabled);
  const toggle = $("#slots-picker-toggle");
  toggle.checked = enabled;
  const card = $("#picker-models-card");
  card.hidden = !enabled;
  const box = $("#picker-models");
  const checked = new Set(((currentConfig.cli && currentConfig.cli.extraModels) || []).map((item) => item.model));
  box.replaceChildren();
  for (const group of groupedModels(currentConfig)) {
    for (const model of group.models) {
      const input = el("input", { type: "checkbox", checked: checked.has(model.id) });
      input.dataset.model = model.id;
      input.dataset.provider = group.name;
      input.dataset.name = labelOf(model);
      input.addEventListener("change", scheduleSlotsSave);
      box.appendChild(el("label", { class: "model-check" }, [input, el("span", { text: labelOf(model) }), el("small", { text: group.name })]));
    }
  }
  if (!box.childElementCount) box.appendChild(hint(t("slots.noProviderModels")));
}
$("#slots-picker-toggle").addEventListener("change", (event) => togglePicker(event.target.checked, event.target));
$("#slots-add").addEventListener("click", () => {
  if (!currentConfig) return;
  $("#slots-table tbody").appendChild(slotRow(claudeModels[0].id, null));
  updateSlotSummary();
});
function allKnownModelIds(config) { return new Set(groupedModels(config).flatMap((group) => group.models.map((model) => model.id))); }
function applyPickerSelections(next, selections) {
  const known = allKnownModelIds(next);
  const selected = selections.filter((entry) => entry.id && entry.provider);
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const currentExtras = (next.cli && next.cli.extraModels) || [];
  const preservedExtras = currentExtras.filter((entry) => !known.has(entry.model));
  next.cli = { ...(next.cli || {}), extraModels: [...preservedExtras, ...selected.map((entry) => ({ model: entry.id, name: entry.name || entry.id }))] };
  const preservedDirect = (next.direct || []).filter((rule) => !known.has(rule.prefix));
  next.direct = [...preservedDirect, ...selected.map((entry) => ({ prefix: entry.id, provider: entry.provider }))];
  // A legacy gpt- prefix rule is intentionally retained by the filter above.
  return next;
}
function pickerSelectionsFromChecklist() {
  return $all("#picker-models input:checked").map((input) => ({ id: input.dataset.model, name: input.dataset.name, provider: input.dataset.provider }));
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
  if (next.picker && next.picker.enabled) applyPickerSelections(next, pickerSelectionsFromChecklist());
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
    const result = await api("/api/providers/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: provider.type, url: provider.url, headers, modelsUrl: provider.modelsUrl, modelsAuthHeader: provider.modelsAuthHeader, probeModel: provider.probeModel }),
    });
    probeStates.set(name, result);
    onComplete && onComplete(result);
    return result;
  } catch (error) {
    const unavailable = error.status === 404;
    const result = { ok: false, auth: unavailable ? "unknown" : "unreachable", models: [], error: unavailable ? t("providers.apiSoon") : error.message, unavailable };
    probeStates.set(name, result);
    onComplete && onComplete(result);
    return result;
  } finally {
    renderHealthProviders();
  }
}
function providerCard(name, provider) {
  const card = el("article", { class: "card provider-card" });
  const title = el("h2", { text: name });
  const stateLine = el("div", { class: "provider-state" });
  const modelText = el("p", { class: "small" });
  const effortText = el("p", { class: "small" });
  const check = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const edit = el("button", { class: "btn secondary", type: "button", text: t("common.edit") });
  const remove = el("button", { class: "btn danger", type: "button", text: t("common.remove") });
  const draw = () => {
    const state = stateFor(name);
    const preset = provider.preset && presetById(provider.preset);
    let kind = provider.type === "chatgpt" ? t("providers.chatgpt") : preset ? preset.name : "";
    if (provider.type !== "chatgpt") { try { kind = `${kind ? kind + " · " : ""}${new URL(provider.url).host}`; } catch { /* keep */ } }
    stateLine.replaceChildren(...[providerState(name, provider), el("span", { class: "small", text: kind }), state && !state.ok && state.error ? el("span", { class: "small bad-text", text: state.error }) : null].filter(Boolean));
    const models = modelsOf(provider);
    modelText.textContent = models.length ? t("providers.modelsCount", { count: models.length, names: models.map(labelOf).join(", ") }) : t("providers.noModels");
    const levels = effortLevelsFor(name, models[0] && models[0].id);
    effortText.textContent = t("providers.effortLevels", { levels: levels.length ? levels.join(" · ") : t("providers.effortNone") });
  };
  check.addEventListener("click", async () => { check.disabled = true; await probeProvider(name, provider); check.disabled = false; draw(); });
  edit.addEventListener("click", () => openProviderForm({ name, provider }));
  remove.addEventListener("click", async () => {
    if (!confirm(t("providers.removeConfirm", { name }))) return;
    const next = clone(currentConfig);
    delete next.providers[name];
    next.routes = Object.fromEntries(Object.entries(next.routes || {}).filter(([, route]) => route.provider !== name));
    next.direct = (next.direct || []).filter((rule) => rule.provider !== name);
    next.cli.extraModels = (next.cli.extraModels || []).filter((entry) => !modelsOf(provider).some((model) => model.id === entry.model));
    try { await configRequest(next); currentConfig = next; providersLoaded = false; slotsLoaded = false; await loadProviders(); toast(t("common.saved")); } catch (error) { toast(t("common.saveFailed"), true, error.message); }
  });
  const quota = quotaLine(name);
  card.append(el("div", { class: "toolbar" }, [title, el("div", { class: "right" }, [check, edit, remove])]), stateLine, modelText, effortText, quota ? el("div", { class: "small", text: quota }) : document.createTextNode(""));
  draw();
  return card;
}
async function loadProviders() {
  providersLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = currentConfig || await api("/api/config");
    const list = $("#providers-list");
    list.replaceChildren(...Object.entries(currentConfig.providers || {}).map(([name, provider]) => providerCard(name, provider)));
    if (!currentConfig.providers || !Object.keys(currentConfig.providers).length) list.appendChild(el("div", { class: "empty-card", text: t("providers.empty") }));
    void Promise.all(Object.entries(currentConfig.providers || {}).map(([name, provider]) => probeProvider(name, provider, () => {
      const existing = $all(".provider-card").find((card) => card.querySelector("h2").textContent === name);
      if (existing) { existing.remove(); list.appendChild(providerCard(name, provider)); }
    })));
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}
$("#providers-add").addEventListener("click", openProviderChooser);
$("#providers-refresh").addEventListener("click", async () => {
  if (!currentConfig) return;
  await Promise.all(Object.entries(currentConfig.providers).map(([name, provider]) => probeProvider(name, provider)));
  providersLoaded = false;
  await loadProviders();
});

// ---- Provider modal -----------------------------------------------------------------

function showModal(content) {
  $("#modal-content").replaceChildren(content);
  $("#modal-backdrop").hidden = false;
  const first = $("#modal-content input, #modal-content button, #modal-content select");
  if (first) setTimeout(() => first.focus(), 0);
}
function closeModal() { $("#modal-backdrop").hidden = true; $("#modal-content").replaceChildren(); }
$("#modal-close").addEventListener("click", closeModal);
$("#modal-backdrop").addEventListener("click", (event) => { if (event.target === $("#modal-backdrop")) closeModal(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#modal-backdrop").hidden) { closeModal(); return; }
  if (event.key === "Enter" && !$("#modal-backdrop").hidden && event.target.tagName !== "TEXTAREA") {
    const action = $("#modal-content [data-default-action]");
    if (action && !action.disabled) { event.preventDefault(); action.click(); }
  }
});
function openProviderChooser() {
  const grid = el("div", { class: "chooser-grid" });
  const chatgpt = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: t("providers.chatgpt") }), el("span", { text: t("providers.chatgptHelp") })]);
  chatgpt.addEventListener("click", () => openProviderForm({ kind: "chatgpt" }));
  grid.appendChild(chatgpt);
  for (const preset of presets) {
    const tile = el("button", { class: "chooser-tile", type: "button" }, [el("strong", { text: preset.name }), el("span", { text: t("providers.presetHelp") })]);
    tile.addEventListener("click", () => openProviderForm({ preset }));
    grid.appendChild(tile);
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
// loses ticks. `box.selected()` returns the chosen {id,name} entries.
function modelChecklist(models, checked) {
  const selected = new Map();
  for (const model of models) if (checked.has(model.id)) selected.set(model.id, { id: model.id, name: labelOf(model) });
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
      input.addEventListener("change", () => { if (input.checked) selected.set(model.id, { id: model.id, name: labelOf(model) }); else selected.delete(model.id); note.textContent = summary(matches.length); });
      grid.appendChild(el("label", { class: "model-check", title: model.id }, [input, el("span", { text: labelOf(model) })]));
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
function openProviderForm(options) {
  const existing = options.provider;
  const preset = options.preset || (existing && existing.preset && presetById(existing.preset));
  const isChatgpt = options.kind === "chatgpt" || (existing && existing.type === "chatgpt");
  const isCustom = options.kind === "custom";
  const displayName = options.name || (preset && preset.name) || (isChatgpt ? t("providers.chatgpt") : t("providers.customName"));
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const currentHeaders = (existing && existing.headers) || {};
  const headerKind = preset ? preset.authHeader : (Object.keys(currentHeaders).some((key) => key.toLowerCase() === "authorization") ? "authorization-bearer" : "x-api-key");
  const existingKey = headerKind === "authorization-bearer" ? String(currentHeaders.authorization || "").replace(/^Bearer\s+/i, "") : currentHeaders["x-api-key"] || "";
  if (existingKey) keyInput.placeholder = t("providers.keySaved");
  const urlInput = el("input", { value: (existing && existing.url) || (preset && preset.anthropicBaseUrl) || "", placeholder: "https://" });
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
    el("small", { text: t("providers.effortLevels", { levels: providerEffortLevels.length ? providerEffortLevels.join(" · ") : t("providers.effortNone") }) }),
    modelsBox,
  ]);
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const advanced = el("details", { class: "details" });
  advanced.append(el("summary", { text: t("common.advanced") }));
  const advancedContent = el("div", { class: "advanced-content" });
  let chatgptFields = [];
  if (!isChatgpt) {
    advancedContent.appendChild(inputRow(t("providers.url"), urlInput, t("providers.urlHelp")));
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
  } else {
    const auth = el("select", {}, [selectOption("auto", t("providers.authAuto")), selectOption("own", t("providers.authOwn")), selectOption("borrow-codex", t("providers.authBorrow"))]);
    auth.value = (existing && existing.auth) || "auto";
    const login = el("button", { class: "btn secondary", type: "button", text: t("providers.login") });
    login.addEventListener("click", () => toast(t("providers.loginHint")));
    const effort = effortSelect((existing && existing.defaultEffort) || "high", ["low", "medium", "high", "xhigh", "max"]);
    const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    chatgptFields = [
      inputRow(t("providers.credentials"), auth, t("providers.credentialsHelp")),
      el("div", { class: "form-field" }, [el("span", { text: t("providers.login") }), el("small", { text: t("providers.loginHelp") })]),
      inputRow(t("providers.defaultEffort"), effort, t("providers.defaultEffortHelp")),
    ];
    void login;
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
    return { type: "anthropic-compatible", url: urlInput.value.trim(), ...(preset ? { preset: preset.id } : {}), ...(Object.keys(readHeaders()).length ? { headers: readHeaders() } : {}) };
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
      slotsLoaded = false;
      providersLoaded = false;
      closeModal();
      await loadProviders();
      toast(t("common.saved"));
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
