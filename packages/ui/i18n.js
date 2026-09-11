"use strict";

// Minimal i18n: no framework, no dependencies. `t(key, vars)` looks up the current
// language's dictionary, falling back to English, then to the key itself.
// Language choice: localStorage.clauderipple_lang, else navigator.language.

const I18N = {
  ko: {
    "brand": "ClaudeRipple",
    "nav.health": "상태",
    "nav.slots": "슬롯 매핑",
    "nav.providers": "프로바이더",
    "nav.logs": "로그",
    "nav.about": "정보",

    "health.title": "상태",
    "health.subtitle": "라우터, settings.json, 프로바이더 상태를 실시간으로 보여줍니다. 5초마다 새로고침.",
    "health.router": "라우터",
    "health.settings": "settings.json",
    "health.providers": "프로바이더",
    "health.cli": "Claude Code CLI",
    "health.k.status": "상태",
    "health.k.version": "버전",
    "health.k.listeningOn": "리스닝 주소",
    "health.k.adminPort": "관리 GUI 포트",
    "health.k.upstream": "업스트림",
    "health.k.routes": "설정된 라우트",
    "health.k.requests": "요청",
    "health.k.consecutiveFailures": "연속 업스트림 실패",
    "health.k.pointsAtRouter": "이 라우터를 가리킴",
    "health.k.cachedVersion": "캐시된 버전",
    "health.running": "실행 중",
    "health.up": "up",
    "health.unreachable": "연결 안 됨",
    "health.reachable": "연결됨",
    "health.elevated": "이상 있음",
    "health.yes": "예",
    "health.no": "아니오 — clauderipple install 실행 필요",
    "health.unset": "(설정 안 됨)",
    "health.requestsFmt": "시작 {started} · 성공 {completed} · 실패 {failed} · 진행 중 {inFlight}",
    "health.noProviders": "설정된 프로바이더가 없습니다 — 프로바이더 탭에서 추가하세요.",
    "health.chatgptSubscription": "ChatGPT 구독",
    "health.credentials": "자격증명",
    "health.weeklyLimitUsed": "{percent}% ({window} 한도 사용)",
    "health.windowWeekly": "주간",
    "health.resetsIn": ", {hours}시간 뒤 초기화",
    "health.homeDir": "홈 디렉터리: {home}",

    "slots.title": "슬롯 매핑",
    "slots.subtitle": "앱 피커의 각 모델 id를 어느 프로바이더의 어떤 모델·effort로 보낼지 정합니다. '통과'로 두면 Anthropic으로 그대로 갑니다.",
    "slots.addSlot": "+ 슬롯 추가",
    "slots.save": "저장",
    "slots.th.slotId": "슬롯 id",
    "slots.th.provider": "프로바이더",
    "slots.th.model": "모델",
    "slots.th.effort": "Effort",
    "slots.slotIdPlaceholder": "claude-...",
    "slots.modelPlaceholder": "모델 id",
    "slots.removeSlot": "슬롯 제거",
    "slots.passthrough": "통과 (Anthropic)",
    "slots.effortNone": "(없음)",
    "slots.saved": "슬롯을 저장했습니다.",
    "slots.saveFailed": "저장 실패: {msg}",
    "slots.loadFailed": "설정을 불러오지 못했습니다: {msg}",
    "slots.duplicateId": "슬롯 id \"{id}\" 중복",
    "slots.modelRequired": "슬롯 \"{id}\": 프로바이더를 지정하면 모델도 필요합니다",

    "providers.title": "프로바이더",
    "providers.subtitle": "ClaudeRipple이 요청을 보낼 수 있는 엔드포인트와 prefix 기반 직접 규칙입니다.",
    "providers.addProvider": "+ 프로바이더 추가",
    "providers.save": "저장",
    "providers.urlLabel": "URL",
    "providers.urlPlaceholder": "https://api.example.com/anthropic",
    "providers.modelsLabel": "모델",
    "providers.modelsPlaceholder": "model-a, model-b (선택, 슬롯 제안용)",
    "providers.typeLabel": "타입",
    "providers.typeAnthropic": "anthropic-compatible (Anthropic Messages 형식을 말하는 URL)",
    "providers.typeChatgpt": "chatgpt (내 ChatGPT 구독)",
    "providers.namePlaceholder": "provider-name",
    "providers.removeProvider": "프로바이더 제거",
    "providers.headersTitle": "헤더 (예: x-api-key)",
    "providers.addHeader": "+ 헤더",
    "providers.headerNamePlaceholder": "헤더 이름",
    "providers.headerValuePlaceholder": "값",
    "providers.credentials": "자격증명",
    "providers.authAuto": "auto — 자체 로그인이 있으면 그것, 없으면 Codex CLI 로그인 빌림",
    "providers.authOwn": "own — clauderipple login 토큰",
    "providers.authBorrow": "borrow-codex — ~/.codex/auth.json 읽기 (우리가 갱신하지 않음)",
    "providers.defaultEffort": "기본 effort",
    "providers.identityLine": "정체 줄",
    "providers.identityLabel": "시스템 프롬프트 앞에 \"너는 <model>이고 Claude Code를 통해 답한다\"를 붙임",
    "providers.append": "추가 문구",
    "providers.appendPlaceholder": "모든 시스템 프롬프트 끝에 붙는 고정 문구. 바꾸면 프롬프트 캐시가 깨지니 자주 바꾸지 마십시오.",
    "providers.signInHint": "clauderipple login (또는 트레이 메뉴)으로 로그인하십시오. 자격증명은 이 기기를 벗어나지 않습니다.",
    "providers.urlPlaceholderChatgpt": "선택 — https://chatgpt.com/backend-api 재정의",
    "providers.directRulesTitle": "직접 규칙",
    "providers.directRulesHint": "아래 prefix로 시작하는 모델의 요청은 해당 프로바이더로 그대로 갑니다.",
    "providers.th.prefix": "Prefix",
    "providers.th.provider": "프로바이더",
    "providers.prefixPlaceholder": "gpt-",
    "providers.addRule": "+ 규칙 추가",
    "providers.saved": "프로바이더를 저장했습니다.",
    "providers.saveFailed": "저장 실패: {msg}",
    "providers.loadFailed": "설정을 불러오지 못했습니다: {msg}",
    "providers.missingName": "이름이 없는 프로바이더가 있습니다",
    "providers.urlRequired": "프로바이더 \"{name}\": URL이 필요합니다",

    "logs.title": "로그",
    "logs.autoscroll": "자동 스크롤",
    "logs.polling": "3초마다 갱신 · 최근 200줄",

    "about.title": "정보",
    "about.body": "ClaudeRipple은 독립 오픈소스 프로젝트이며 Anthropic·OpenAI와 제휴·보증·후원 관계가 없습니다. Claude와 Claude Code는 Anthropic, PBC의 상표입니다.",
    "about.license": "라이선스: MIT",

    "lang.toggleKo": "한국어",
    "lang.toggleEn": "English",
  },
  en: {
    "brand": "ClaudeRipple",
    "nav.health": "Health",
    "nav.slots": "Slots",
    "nav.providers": "Providers",
    "nav.logs": "Logs",
    "nav.about": "About",

    "health.title": "Health",
    "health.subtitle": "Live status of the router, settings.json, and every provider. Refreshes every 5s.",
    "health.router": "Router",
    "health.settings": "settings.json",
    "health.providers": "Providers",
    "health.cli": "Claude Code CLI",
    "health.k.status": "status",
    "health.k.version": "version",
    "health.k.listeningOn": "listening on",
    "health.k.adminPort": "admin GUI port",
    "health.k.upstream": "upstream",
    "health.k.routes": "routes configured",
    "health.k.requests": "requests",
    "health.k.consecutiveFailures": "consecutive upstream failures",
    "health.k.pointsAtRouter": "points at this router",
    "health.k.cachedVersion": "cached version",
    "health.running": "running",
    "health.up": "up",
    "health.unreachable": "unreachable",
    "health.reachable": "reachable",
    "health.elevated": "elevated",
    "health.yes": "yes",
    "health.no": "no — run `clauderipple install`",
    "health.unset": "(unset)",
    "health.requestsFmt": "{started} started · {completed} ok · {failed} failed · {inFlight} in flight",
    "health.noProviders": "No providers configured yet — add one under Providers.",
    "health.chatgptSubscription": "ChatGPT subscription",
    "health.credentials": "credentials",
    "health.weeklyLimitUsed": "{percent}% of {window} limit used",
    "health.windowWeekly": "weekly",
    "health.resetsIn": ", resets in {hours}h",
    "health.homeDir": "Home directory: {home}",

    "slots.title": "Slots",
    "slots.subtitle": "Map each app-picker model id to a provider, model, and effort. Rows set to \"Passthrough\" go straight to Anthropic.",
    "slots.addSlot": "+ Add slot",
    "slots.save": "Save",
    "slots.th.slotId": "Slot id",
    "slots.th.provider": "Provider",
    "slots.th.model": "Model",
    "slots.th.effort": "Effort",
    "slots.slotIdPlaceholder": "claude-...",
    "slots.modelPlaceholder": "model id",
    "slots.removeSlot": "Remove slot",
    "slots.passthrough": "Passthrough (Anthropic)",
    "slots.effortNone": "(none)",
    "slots.saved": "Slots saved.",
    "slots.saveFailed": "Save failed: {msg}",
    "slots.loadFailed": "Failed to load config: {msg}",
    "slots.duplicateId": "duplicate slot id \"{id}\"",
    "slots.modelRequired": "slot \"{id}\": model is required when a provider is set",

    "providers.title": "Providers",
    "providers.subtitle": "Endpoints ClaudeRipple can route requests to, and prefix-based direct rules.",
    "providers.addProvider": "+ Add provider",
    "providers.save": "Save",
    "providers.urlLabel": "URL",
    "providers.urlPlaceholder": "https://api.example.com/anthropic",
    "providers.modelsLabel": "Models",
    "providers.modelsPlaceholder": "model-a, model-b (optional, for slot suggestions)",
    "providers.typeLabel": "Type",
    "providers.typeAnthropic": "anthropic-compatible (URL that speaks Anthropic Messages)",
    "providers.typeChatgpt": "chatgpt (your ChatGPT subscription)",
    "providers.namePlaceholder": "provider-name",
    "providers.removeProvider": "Remove provider",
    "providers.headersTitle": "Headers (e.g. x-api-key)",
    "providers.addHeader": "+ Header",
    "providers.headerNamePlaceholder": "Header name",
    "providers.headerValuePlaceholder": "Value",
    "providers.credentials": "Credentials",
    "providers.authAuto": "auto — own login if present, else borrow the Codex CLI's",
    "providers.authOwn": "own — tokens from `clauderipple login`",
    "providers.authBorrow": "borrow-codex — read ~/.codex/auth.json (never refreshed by us)",
    "providers.defaultEffort": "Default effort",
    "providers.identityLine": "Identity line",
    "providers.identityLabel": "prefix the system prompt with “You are <model>, answering through Claude Code”",
    "providers.append": "Append",
    "providers.appendPlaceholder": "Fixed text appended to every system prompt. Keep it constant: changing it breaks the prompt cache.",
    "providers.signInHint": "Sign in with clauderipple login (or the tray menu). Credentials never leave this machine.",
    "providers.urlPlaceholderChatgpt": "optional — override https://chatgpt.com/backend-api",
    "providers.directRulesTitle": "Direct rules",
    "providers.directRulesHint": "A request whose model starts with a prefix below goes to that provider unchanged.",
    "providers.th.prefix": "Prefix",
    "providers.th.provider": "Provider",
    "providers.prefixPlaceholder": "gpt-",
    "providers.addRule": "+ Add rule",
    "providers.saved": "Providers saved.",
    "providers.saveFailed": "Save failed: {msg}",
    "providers.loadFailed": "Failed to load config: {msg}",
    "providers.missingName": "a provider is missing a name",
    "providers.urlRequired": "provider \"{name}\": URL is required",

    "logs.title": "Logs",
    "logs.autoscroll": "Auto-scroll",
    "logs.polling": "Polling every 3s · last 200 lines",

    "about.title": "About",
    "about.body": "ClaudeRipple is an independent open-source project, not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC.",
    "about.license": "License: MIT",

    "lang.toggleKo": "한국어",
    "lang.toggleEn": "English",
  },
};

function detectLang() {
  try {
    const saved = localStorage.getItem("clauderipple_lang");
    if (saved === "ko" || saved === "en") return saved;
  } catch {
    /* localStorage unavailable */
  }
  return navigator.language && navigator.language.startsWith("ko") ? "ko" : "en";
}

const CURRENT_LANG = detectLang();

function t(key, vars) {
  const dict = I18N[CURRENT_LANG] || I18N.en;
  let str = dict[key] !== undefined ? dict[key] : (I18N.en[key] !== undefined ? I18N.en[key] : key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

function applyStaticI18n() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n"));
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", t(node.getAttribute("data-i18n-placeholder")));
  }
  document.title = t("brand");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyStaticI18n);
} else {
  applyStaticI18n();
}
