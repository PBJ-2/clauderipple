"use strict";

// ---- tiny helpers -----------------------------------------------------------------

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children || []) {
    if (c === null || c === undefined) continue;
    n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

let toastTimer = null;
function toast(msg, isError) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", !!isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error((body && (body.error || (body.errors || []).join("; "))) || `HTTP ${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

// ---- navigation ---------------------------------------------------------------------

const DEFAULT_SLOTS = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];

// Declared before the first showView() call below: `let` bindings are in the temporal dead zone
// until their declaration runs, and loading the page at #slots used to throw here.
let slotsLoaded = false;
let providersLoaded = false;
let currentConfig = null;

function showView(name) {
  for (const b of $all(".nav-btn")) b.classList.toggle("active", b.dataset.view === name);
  for (const v of $all(".view")) v.classList.toggle("active", v.id === `view-${name}`);
  location.hash = name;
  if (name === "slots" && !slotsLoaded) loadSlots();
  if (name === "providers" && !providersLoaded) loadProviders();
}

for (const b of $all(".nav-btn")) b.addEventListener("click", () => showView(b.dataset.view));
showView((location.hash || "#health").slice(1) || "health");
window.addEventListener("hashchange", () => showView((location.hash || "#health").slice(1) || "health"));

// ---- language toggle --------------------------------------------------------------------

(function setupLangToggle() {
  const btn = $("#lang-toggle");
  if (!btn) return;
  const current = (typeof CURRENT_LANG !== "undefined" && CURRENT_LANG) || "en";
  btn.textContent = current === "ko" ? t("lang.toggleEn") : t("lang.toggleKo");
  btn.addEventListener("click", () => {
    try {
      localStorage.setItem("clauderipple_lang", current === "ko" ? "en" : "ko");
    } catch {
      /* localStorage unavailable */
    }
    location.reload();
  });
})();

// ---- Health ---------------------------------------------------------------------------

function badge(ok, textOk, textBad) {
  const b = el("span", { class: `badge ${ok ? "ok" : "bad"} dot` }, [ok ? textOk : textBad]);
  return b;
}

async function refreshHealth() {
  let s;
  try {
    s = await api("/api/status");
  } catch (e) {
    $("#health-router").innerHTML = "";
    $("#health-router").appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, [t("health.router")]), badge(false, t("health.up"), t("health.unreachable"))]));
    return;
  }

  const router = $("#health-router");
  router.innerHTML = "";
  const rows = [
    [t("health.k.status"), badge(true, t("health.running"), "")],
    [t("health.k.version"), s.version],
    [t("health.k.listeningOn"), `${s.listen.host}:${s.listen.port}`],
    [t("health.k.adminPort"), s.adminPort],
    [t("health.k.upstream"), s.upstream],
    [t("health.k.routes"), String(s.routes)],
    [t("health.k.requests"), t("health.requestsFmt", { started: s.stats.started, completed: s.stats.completed, failed: s.stats.failed, inFlight: s.stats.inFlight })],
    [t("health.k.consecutiveFailures"), el("span", {}, [
      String(s.consecutiveUpstreamFailures),
      s.consecutiveUpstreamFailures > 0 ? badge(false, "", t("health.elevated")) : null,
    ])],
  ];
  for (const [k, v] of rows) {
    const valueSpan = el("span", { class: "v" }, [v]);
    router.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, [k]), valueSpan]));
  }

  const settings = $("#health-settings");
  settings.innerHTML = "";
  settings.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, [t("health.k.pointsAtRouter")]), s.settings.pointsAtRouter ? badge(true, t("health.yes"), "") : badge(false, "", t("health.no"))]));
  settings.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, ["HTTPS_PROXY"]), el("span", { class: "v" }, [s.settings.HTTPS_PROXY || t("health.unset")])]));
  settings.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, ["NODE_EXTRA_CA_CERTS"]), el("span", { class: "v" }, [s.settings.NODE_EXTRA_CA_CERTS || t("health.unset")])]));

  const tbody = $("#health-providers tbody");
  tbody.innerHTML = "";
  const names = Object.keys(s.providers);
  if (names.length === 0) {
    tbody.appendChild(el("tr", {}, [el("td", { colspan: "3", class: "small" }, [t("health.noProviders")])]));
  }
  for (const name of names) {
    const p = s.providers[name];
    const quota = s.chatgpt && s.chatgpt.quota && s.chatgpt.quota[name];
    const auth = s.chatgpt && s.chatgpt.auth && s.chatgpt.auth[name];
    const details = [p.type === "chatgpt" ? t("health.chatgptSubscription") : p.url];
    if (p.type === "chatgpt" && auth) details.push(`${t("health.credentials")}: ${auth}`);
    if (quota && quota.rate_limits && quota.rate_limits.primary) {
      const pr = quota.rate_limits.primary;
      const hours = pr.reset_after_seconds ? Math.round(pr.reset_after_seconds / 3600) : null;
      const windowLabel = pr.window_minutes === 10080 ? t("health.windowWeekly") : (pr.window_minutes / 60) + "h";
      details.push(
        `${quota.plan_type || "plan"}: ` +
          t("health.weeklyLimitUsed", { percent: pr.used_percent, window: windowLabel }) +
          (hours !== null ? t("health.resetsIn", { hours }) : "")
      );
    }
    tbody.appendChild(el("tr", {}, [
      el("td", {}, [name, el("div", { class: "small" }, [p.type])]),
      el("td", { class: "small" }, details.flatMap((d, i) => (i ? [el("br"), d] : [d]))),
      el("td", {}, [p.reachable ? badge(true, t("health.reachable"), "") : badge(false, "", t("health.unreachable"))]),
    ]));
  }

  const cli = $("#health-cli");
  cli.innerHTML = "";
  cli.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, [t("health.k.cachedVersion")]), el("span", { class: "v" }, [s.cliVersion])]));

  renderPicker(s.picker || { enabled: false, hosts: [], last: null });
  $("#about-home").textContent = t("health.homeDir", { home: s.home });
}

let pickerBusy = false;
function renderPicker(p) {
  const rows = $("#picker-rows");
  rows.innerHTML = "";
  rows.appendChild(el("div", { class: "row" }, [el("span", { class: "k" }, [t("picker.k.state")]), p.enabled ? badge(true, t("picker.on"), "") : el("span", { class: "v" }, [t("picker.off")])]));
  const last = p.last && typeof p.last === "object" ? p.last : null;
  rows.appendChild(el("div", { class: "row" }, [
    el("span", { class: "k" }, [t("picker.k.lastInjection")]),
    el("span", { class: "v" }, [last ? t("picker.lastFmt", { count: last.injected != null ? last.injected : "?", surfaces: (last.surfaces || []).map((x) => x.id).join(", ") || "-", at: last.at || "" }) : t("picker.never")]),
  ]));
  const btn = $("#picker-toggle");
  btn.textContent = p.enabled ? t("picker.turnOff") : t("picker.turnOn");
  btn.className = p.enabled ? "btn secondary" : "btn";
  btn.disabled = pickerBusy;
  btn.onclick = async () => {
    if (pickerBusy) return;
    const on = !p.enabled;
    if (on && !confirm(t("picker.confirmOn"))) return;
    pickerBusy = true;
    btn.disabled = true;
    $("#picker-msg").textContent = t("picker.working");
    try {
      const r = await api("/api/picker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: on }) });
      $("#picker-msg").textContent = on ? t("picker.doneOn") : t("picker.doneOff");
      console.log(r.output);
    } catch (e) {
      $("#picker-msg").textContent = (e.body && e.body.output) || e.message;
    } finally {
      pickerBusy = false;
      refreshHealth();
    }
  };
}

refreshHealth();
setInterval(refreshHealth, 5000);

// ---- Slots ----------------------------------------------------------------------------

function providerOptions(selected) {
  const sel = el("select", {});
  sel.appendChild(el("option", { value: "" }, [t("slots.passthrough")]));
  for (const name of Object.keys(currentConfig.providers)) {
    sel.appendChild(el("option", { value: name }, [name]));
  }
  sel.value = selected || "";
  return sel;
}

function effortSelect(selected) {
  const sel = el("select", {});
  for (const v of ["", "low", "medium", "high", "xhigh", "max"]) {
    sel.appendChild(el("option", { value: v }, [v === "" ? t("slots.effortNone") : v]));
  }
  sel.value = selected || "";
  return sel;
}

function slotRow(id, route) {
  const tr = el("tr", {});
  const idInput = el("input", { value: id, placeholder: t("slots.slotIdPlaceholder") });
  const provSel = providerOptions(route ? route.provider : "");
  const modelInput = el("input", { value: route ? route.model : "", placeholder: t("slots.modelPlaceholder"), list: "model-suggestions-inline" });
  const effSel = effortSelect(route ? route.effort : "");
  const dl = el("datalist", { id: `dl-${Math.random().toString(36).slice(2)}` });
  modelInput.setAttribute("list", dl.id);

  function updateSuggestions() {
    dl.innerHTML = "";
    const p = currentConfig.providers[provSel.value];
    for (const m of (p && p.models) || []) dl.appendChild(el("option", { value: m }));
    modelInput.disabled = !provSel.value;
    effSel.disabled = !provSel.value;
    if (!provSel.value) { modelInput.value = ""; effSel.value = ""; }
  }
  provSel.addEventListener("change", updateSuggestions);
  updateSuggestions();

  const isDefault = DEFAULT_SLOTS.includes(id);
  const del = el("button", { class: "icon-btn", title: t("slots.removeSlot"), onclick: () => { tr.remove(); } }, ["✕"]);
  if (isDefault) del.style.visibility = "hidden";

  tr.appendChild(el("td", {}, [idInput]));
  tr.appendChild(el("td", {}, [provSel]));
  tr.appendChild(el("td", {}, [modelInput, dl]));
  tr.appendChild(el("td", {}, [effSel]));
  tr.appendChild(el("td", {}, [del]));
  tr._get = () => ({ id: idInput.value.trim(), provider: provSel.value, model: modelInput.value.trim(), effort: effSel.value });
  return tr;
}

async function loadSlots() {
  slotsLoaded = true;
  try {
    currentConfig = await api("/api/config");
  } catch (e) {
    toast(t("slots.loadFailed", { msg: e.message }), true);
    return;
  }
  const tbody = $("#slots-table tbody");
  tbody.innerHTML = "";
  const seen = new Set();
  for (const id of DEFAULT_SLOTS) {
    seen.add(id);
    tbody.appendChild(slotRow(id, currentConfig.routes[id]));
  }
  for (const [id, route] of Object.entries(currentConfig.routes)) {
    if (seen.has(id)) continue;
    tbody.appendChild(slotRow(id, route));
  }
}

$("#slots-add").addEventListener("click", () => {
  $("#slots-table tbody").appendChild(slotRow("", null));
});

$("#slots-save").addEventListener("click", async () => {
  if (!currentConfig) return;
  const rows = $all("#slots-table tbody tr").map((tr) => tr._get());
  const routes = {};
  const errors = [];
  const seenIds = new Set();
  for (const r of rows) {
    if (!r.id) continue;
    if (seenIds.has(r.id)) { errors.push(t("slots.duplicateId", { id: r.id })); continue; }
    seenIds.add(r.id);
    if (!r.provider) continue; // passthrough
    if (!r.model) { errors.push(t("slots.modelRequired", { id: r.id })); continue; }
    routes[r.id] = { provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}) };
  }
  if (errors.length) { toast(errors.join("; "), true); return; }
  const next = { ...currentConfig, routes };
  try {
    await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    currentConfig = next;
    toast(t("slots.saved"));
  } catch (e) {
    toast(t("slots.saveFailed", { msg: e.message }), true);
  }
});

// ---- Providers --------------------------------------------------------------------------

function headerRow(key, value, onRemove) {
  const row = el("div", { class: "headers-row" });
  const k = el("input", { value: key || "", placeholder: t("providers.headerNamePlaceholder") });
  const v = el("input", { value: value || "", placeholder: t("providers.headerValuePlaceholder") });
  const del = el("button", { class: "icon-btn", onclick: onRemove }, ["✕"]);
  row.appendChild(k); row.appendChild(v); row.appendChild(del);
  row._get = () => [k.value.trim(), v.value];
  return row;
}

function providerCard(name, p) {
  const card = el("div", { class: "card" });
  const nameInput = el("input", { value: name || "", placeholder: t("providers.namePlaceholder"), style: "font-weight:600;max-width:220px;" });
  const typeSel = el("select", { style: "max-width:220px;" }, [
    el("option", { value: "anthropic-compatible" }, [t("providers.typeAnthropic")]),
    el("option", { value: "chatgpt" }, [t("providers.typeChatgpt")]),
  ]);
  typeSel.value = (p && p.type) || "anthropic-compatible";
  const urlInput = el("input", { value: (p && p.url) || "", placeholder: t("providers.urlPlaceholder") });
  const modelsInput = el("input", { value: (p && p.models && p.models.join(", ")) || "", placeholder: t("providers.modelsPlaceholder") });

  // chatgpt-only fields
  const authSel = el("select", { style: "max-width:320px;" }, [
    el("option", { value: "auto" }, [t("providers.authAuto")]),
    el("option", { value: "own" }, [t("providers.authOwn")]),
    el("option", { value: "borrow-codex" }, [t("providers.authBorrow")]),
  ]);
  authSel.value = (p && p.auth) || "auto";
  const identityChk = el("input", { type: "checkbox" });
  identityChk.checked = !(p && p.identity === false);
  const effortSel = el("select", { style: "max-width:220px;" }, ["low", "medium", "high", "xhigh", "max"].map((v) => el("option", { value: v }, [v])));
  effortSel.value = (p && p.defaultEffort) || "high";
  const appendTa = el("textarea", { rows: "4", placeholder: t("providers.appendPlaceholder") });
  appendTa.value = (p && p.instructionsAppend) || "";

  const headersWrap = el("div", { class: "headers-list" });
  const initialHeaders = (p && p.headers) || {};
  let maskExisting = Object.keys(initialHeaders).length > 0;
  for (const [k, v] of Object.entries(initialHeaders)) {
    const row = headerRow(k, maskExisting ? "••••••••" : v, () => row.remove());
    row._unmasked = false;
    row._get = () => {
      const kk = row.querySelector("input").value.trim();
      const vv = row.querySelectorAll("input")[1].value;
      return [kk, vv === "••••••••" ? initialHeaders[k] : vv];
    };
    headersWrap.appendChild(row);
  }
  const addHeaderBtn = el("button", { class: "btn secondary", type: "button" }, [t("providers.addHeader")]);
  addHeaderBtn.addEventListener("click", () => {
    const row = headerRow("", "", () => row.remove());
    headersWrap.appendChild(row);
  });

  const delProviderBtn = el("button", { class: "btn danger", type: "button" }, [t("providers.removeProvider")]);
  delProviderBtn.addEventListener("click", () => card.remove());

  card.appendChild(el("div", { class: "toolbar" }, [nameInput, el("div", { class: "right" }, [delProviderBtn])]));
  const urlRow = el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.urlLabel")]), urlInput]);
  const compatBlock = el("div", {}, [
    el("div", { style: "margin-top:10px;" }, [el("span", { class: "small" }, [t("providers.headersTitle")])]),
    headersWrap,
    el("div", { style: "margin-top:6px;" }, [addHeaderBtn]),
  ]);
  const chatgptBlock = el("div", { class: "rows" }, [
    el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.credentials")]), authSel]),
    el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.defaultEffort")]), effortSel]),
    el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.identityLine")]), el("label", { class: "small" }, [identityChk, " " + t("providers.identityLabel")])]),
    el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.append")]), appendTa]),
    el("div", { class: "small" }, [t("providers.signInHint")]),
  ]);
  card.appendChild(el("div", { class: "rows" }, [
    el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.typeLabel")]), typeSel]),
    urlRow,
    el("div", { class: "row" }, [el("span", { class: "k" }, [t("providers.modelsLabel")]), modelsInput]),
  ]));
  card.appendChild(compatBlock);
  card.appendChild(chatgptBlock);

  function syncType() {
    const gpt = typeSel.value === "chatgpt";
    compatBlock.style.display = gpt ? "none" : "";
    chatgptBlock.style.display = gpt ? "" : "none";
    urlInput.placeholder = gpt ? t("providers.urlPlaceholderChatgpt") : t("providers.urlPlaceholder");
    if (gpt && !modelsInput.value) modelsInput.value = "gpt-5.6-terra, gpt-5.6-sol, gpt-5.6-luna, gpt-6-astra";
  }
  typeSel.addEventListener("change", syncType);
  syncType();

  card._get = () => {
    const models = modelsInput.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (typeSel.value === "chatgpt") {
      const url = urlInput.value.trim();
      const append = appendTa.value;
      return {
        name: nameInput.value.trim(),
        provider: {
          type: "chatgpt",
          auth: authSel.value,
          defaultEffort: effortSel.value,
          identity: identityChk.checked,
          ...(url ? { url } : {}),
          ...(append ? { instructionsAppend: append } : {}),
          ...(models.length ? { models } : {}),
        },
      };
    }
    const headers = {};
    for (const row of $all(".headers-row", headersWrap)) {
      const [k, v] = row._get();
      if (k) headers[k] = v;
    }
    return {
      name: nameInput.value.trim(),
      provider: {
        type: "anthropic-compatible",
        url: urlInput.value.trim(),
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(models.length ? { models } : {}),
      },
    };
  };
  return card;
}

function directRow(prefix, provider) {
  const tr = el("tr", {});
  const prefixInput = el("input", { value: prefix || "", placeholder: t("providers.prefixPlaceholder") });
  const provSel = providerOptions(provider || "");
  provSel.querySelector('option[value=""]').remove();
  const del = el("button", { class: "icon-btn", onclick: () => tr.remove() }, ["✕"]);
  tr.appendChild(el("td", {}, [prefixInput]));
  tr.appendChild(el("td", {}, [provSel]));
  tr.appendChild(el("td", {}, [del]));
  tr._get = () => ({ prefix: prefixInput.value.trim(), provider: provSel.value });
  return tr;
}

async function loadProviders() {
  providersLoaded = true;
  try {
    currentConfig = currentConfig || (await api("/api/config"));
  } catch (e) {
    toast(t("providers.loadFailed", { msg: e.message }), true);
    return;
  }
  const list = $("#providers-list");
  list.innerHTML = "";
  for (const [name, p] of Object.entries(currentConfig.providers)) {
    list.appendChild(providerCard(name, p));
  }
  const tbody = $("#direct-table tbody");
  tbody.innerHTML = "";
  for (const d of currentConfig.direct) tbody.appendChild(directRow(d.prefix, d.provider));
}

$("#providers-add").addEventListener("click", () => {
  $("#providers-list").appendChild(providerCard("", null));
});

$("#direct-add").addEventListener("click", () => {
  $("#direct-table tbody").appendChild(directRow("", ""));
});

$("#providers-save").addEventListener("click", async () => {
  if (!currentConfig) return;
  const providers = {};
  const errors = [];
  for (const card of $all("#providers-list .card")) {
    const { name, provider } = card._get();
    if (!name) { errors.push(t("providers.missingName")); continue; }
    if (provider.type === "anthropic-compatible" && !provider.url) { errors.push(t("providers.urlRequired", { name })); continue; }
    providers[name] = provider;
  }
  const direct = $all("#direct-table tbody tr").map((tr) => tr._get()).filter((d) => d.prefix && d.provider);
  if (errors.length) { toast(errors.join("; "), true); return; }
  const next = { ...currentConfig, providers, direct };
  try {
    await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    currentConfig = next;
    slotsLoaded = false; // provider list changed; reload next time Slots is opened
    toast(t("providers.saved"));
  } catch (e) {
    toast(t("providers.saveFailed", { msg: e.message }), true);
  }
});

// ---- Logs -----------------------------------------------------------------------------

function colorizeLogLine(line) {
  let cls = "tag-PASS";
  if (/^\S+\s\S+\s(ERROR|error)/.test(line) || / ERROR /.test(line)) cls = "tag-ERR";
  else if (/ WARN /.test(line)) cls = "tag-WARN";
  else if (/^\S+ \S+ [A-Z][A-Z0-9._-]+ /.test(line) && !/^\S+ \S+ PASS /.test(line)) cls = "tag-PROVIDER";
  return el("div", { class: cls }, [line]);
}

let logsTimer = null;
async function refreshLogs() {
  const box = $("#logbox");
  if (!box) return;
  try {
    const res = await fetch("/api/logs?n=200");
    const text = await res.text();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.innerHTML = "";
    for (const line of text.split("\n")) {
      if (line === "") continue;
      box.appendChild(colorizeLogLine(line));
    }
    if ($("#logs-autoscroll").checked || atBottom) box.scrollTop = box.scrollHeight;
  } catch {
    /* keep last good content */
  }
}
refreshLogs();
logsTimer = setInterval(refreshLogs, 3000);
