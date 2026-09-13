# 인수인계 — 2026-09-13 오후

> 다음 세션이 처음 읽을 문서. 기술 근거는 `docs/ARCHITECTURE.md`, 규칙은 `CLAUDE.md`,
> 메모리는 `~/.claude/projects/-Users-pbj-Downloads/memory/clauderipple-project.md`.

## 지금 상태 한 줄
ClaudeRipple(클로드리플)은 **주군 데스크톱에서 실전 가동 중이고, GPT 경로가 자체 ChatGPT 어댑터로
전환됐다.** proxenos는 더 이상 체인에 없다(데몬은 8787에 켜져 있으나 미사용). 테스트 40개 통과.
`main` 브랜치, 원격 없음.

## 실전 환경 (건드리기 전에 알 것)
| 항목 | 값 |
|---|---|
| 저장소 | `~/Documents/ClaudeRipple` (TypeScript, Node 24 타입 스트리핑, 빌드 없이 `node file.ts`) |
| 홈 | `~/.clauderipple/` — config.json, ca/leaf 인증서, `paths.json`, logs/, config 백업 `config.json.bak-*` |
| 라우터 | launchd `com.clauderipple.router`, 포트 **8791**, 관리 GUI **8792** (`ClaudeRipple.app` 런처 번들로 실행) |
| settings.json | `HTTPS_PROXY=http://127.0.0.1:8791`, `NODE_EXTRA_CA_CERTS=~/.clauderipple/ca.pem`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000` |
| 프로바이더 | `providers.chatgpt = {type:"chatgpt", auth:"borrow-codex", instructionsAppend:<proxenos append 문구>}`. 되돌리기 = `~/.clauderipple/config.json.bak-proxenos-20260913T133247`를 config.json으로 복사(핫리로드, 재시작 불필요) |
| 프로토타입 | `~/.local/share/claude-router/` 파이썬, 포트 8790, **켜져 있으나 미사용**. 되돌리기 = settings의 프록시 주소를 8790으로 |
| 백업 | `~/.claude/settings.json.bak-clauderipple-20260911T074058` |

## 오늘(09-13) 확정된 사실 (재조사 금지)
- 자체 어댑터 실측 통과: 스트리밍·도구 호출·다중 턴·비스트리밍·count_tokens·`@effort`. terra 캐시 적중 2회차부터 **98.4%**.
  luna는 백엔드가 `cached_tokens: 0`을 준다(proxenos도 동일). 캐시 지표는 terra/sol로 본다.
- 한도는 `x-codex-*` **응답 헤더**로 온다. `codex.rate_limits` SSE 이벤트는 한 번도 안 왔다. 어댑터가 둘 다 읽고 GUI `/api/status.chatgpt.quota`에 나온다.
- **Claude Code 2.1.266의 Artifact 도구 스키마에 룩어헤드 정규식이 들어가 Codex 백엔드가 400을 냈다.** proxenos도 같이 깨졌다
  (주군의 GPT 에이전트가 오늘 오전부터 전부 실패). 번역기가 그런 pattern을 걸러 보낸다(`normalizeSchema`). 재발하면 로그의
  `WARN chatgpt chatgpt: upstream 400 …` 본문을 보라.
- `launchctl kickstart -k`는 SIGTERM 5초 뒤 SIGKILL이다. `clauderipple restart`는 이제 직접 SIGTERM → 종료 대기(최대 120초) → launchd KeepAlive 재기동.
- `server.close()`는 새 TCP 연결만 막는다. 드레인 중 기존 터널로 오는 새 모델 호출은 503+retry-after로 거절(CLI가 재시도). 드레인 예산 90초.

## 오늘의 사고 (재발 방지)
1. 13:32 자체 어댑터로 전환 직후 실전 요청이 400 → 즉시 proxenos로 원복 → 원인(Artifact 정규식)이 proxenos에도 해당함을 확인 →
   스크럽 구현·실측 증명 후 재전환. **전환은 항상 격리 라우터에서 실제 CLI 요청 형태까지 재현한 뒤에.** curl 최소 요청만으로는 못 잡는다.
2. 13:35 `restart`(kickstart -k)가 드레인 중 SIGKILL → 모델 호출 2건 절단. 13:38 새 restart 경로로도 45초를 다 채우고 2건 절단(기존 터널 새 요청 유입).
   둘 다 고쳤고 13:41 재시작은 `drain complete, model calls still open: 0`으로 깨끗이 끝났다. 그래도 **실전 재시작은 `/api/status`의
   `messagesInFlight`가 0인 순간을 골라서.**

## 2026-09-13 추가
- **피커 모드 실전 통과.** 원인 둘: Config Library 경로는 `Claude-3p/`, 부트스트랩 요청의 accept-encoding은 유지하고 라우터가 풀어서 편집. 피커 id는 접미사 없이(`gpt-5.6-luna`), 강도는 앱 선택이 그대로 간다. 정체 문장에 effort 포함.
- **자체 ChatGPT 어댑터 실전 가동**(proxenos 미사용). 관찰된 문제 둘, 미해결:
  1. `No tool call found for function call output with call_id call_…` 400이 GPT 서브에이전트 긴 세션에서 툴 호출 턴마다 한 번씩 나왔다(15:26 로그). 재시도는 성공. `providers.chatgpt.debugDump=true`가 켜져 있어 다음 발생 시 `~/.clauderipple/debug/upstream-*-400.json`에 요청 전문이 남는다. 그 파일에서 해당 call_id의 function_call이 왜 빠졌는지 보면 된다.
  2. 캐시 적중이 낮다: in=131k 중 cached=22k(≈17%). 수용 기준 ≥90%. 22k에서 매 턴 갈라지는 지점을 찾아야 함(instructions 뒤 input 첫 항목이 턴마다 달라지는지). 두 연속 요청을 dump해 diff.
- **토큰 표시**: CLI는 스트리밍 블록마다 usage 스냅샷을 찍으므로 message_start에 입력 토큰 추정치를 넣었다(실측값은 message_delta). 앱 패널 숫자가 실제에 가깝게 나오는지 다음 서브에이전트 실행에서 확인.
- **agent-title 훅**(서브에이전트 제목에 모델·강도): `clauderipple agent-title on|off`, 트레이 메뉴, `POST /api/agent-title`. GUI 토글은 아직 없음.
- **GUI 전면 개편**(비개발자용, 프리셋·연결 확인·드롭다운 매핑) 커밋 ce1f9d6. 프리셋 카탈로그 `packages/router/src/presets.ts`(공식 문서 URL 주석). Grok·Mistral은 OpenAI 방식만이라 번역기 필요 → 미지원. 새 GUI는 격리 라우터에서 흐름 검증했고 실제 앱 창 스크린샷 검증은 못 했다(화면 접근 거부됨) — 주군이 직접 보고 어색한 문구·동작을 알려주면 고친다.

## 주군이 직접 할 일 (세션이 못 함)
- **피커 모드 켜기**(아직 안 하심): 메뉴 막대 ClaudeRipple 아이콘 → "Code 탭 피커에 GPT 모델 이름 표시…"
  (또는 GUI 상태 화면의 "모델 피커" 카드 버튼, 또는 터미널 `clauderipple picker on`) → macOS 암호 창(키체인 신뢰)
  → **Claude Desktop 완전 종료 후 재실행** → Code 탭 피커에 GPT-5.6 Terra/Sol/Luna, GPT-6 Astra가 보이는지 확인.
  라우터 재시작은 필요 없다(config 핫리로드). 되돌리기는 같은 메뉴의 "끄기". 앱은 `/Applications/ClaudeRipple.app`
  (빌드 원본 `packages/app/release/mac-arm64/`).
- proxenos 데몬(8787)·프로토타입(8790) 정리는 주군 확인 후.

## 다음 세션이 할 일 (우선순위순)
1. **실전 캐시 적중 관찰**: `grep "CHATGPT" ~/.clauderipple/logs/router.log | tail -30`에서 `cached=` 값. 다중 턴 세션에서 90% 밑이면
   `prompt_cache_key`(첫 user 메시지 기반)와 instructions 고정성부터 의심.
2. **피커 모드 실전 검증**(주군이 켠 뒤): `grep "PICKER" ~/.clauderipple/logs/router.log`. 안 뜨면 (a) `grep "WEB claude.ai"`, (b) 부트스트랩 경로,
   (c) 렌더러 필터 순. 휴리스틱은 `packages/router/src/picker.ts`.
3. GUI: 피커 상태 표시(`/api/status.picker` 있음), 한도 표시는 헤더 기반 값으로 이미 채워짐. 메뉴 막대 앱 재빌드(`cd packages/app && npm run dist`).
4. README 영어 마무리, GitHub 공개 준비(원격 없음), 스크린샷.
5. 프로토타입(8790)·proxenos(8787) 해제는 주군 확인 후.

## 검증 명령
```bash
cd ~/Documents/ClaudeRipple && npx tsc -p tsconfig.json --noEmit && npm test
node packages/cli/src/index.ts status
tail -20 ~/.clauderipple/logs/router.log
```
테스트는 `CLAUDERIPPLE_HOME`·`CLAUDE_SETTINGS_PATH`로 격리한 임시 홈에서만. 외부 네트워크가 필요한 실측은
`dangerouslyDisableSandbox`. 격리 라우터는 `CLAUDERIPPLE_HOME=<임시홈> node packages/router/src/index.ts`로 8793 등 다른 포트에 띄우고
**포트·PID로만** 죽인다. 실전 라우터는 `clauderipple restart` 외의 방법으로 죽이지 말 것.
