# 인수인계 — 2026-09-13 밤 (최신)

> 다음 세션이 처음 읽을 문서. 기술 근거는 `docs/ARCHITECTURE.md`, 규칙은 `CLAUDE.md`,
> 메모리는 `~/.claude/projects/-Users-pbj-Downloads/memory/clauderipple-project.md`.

## 지금 상태 한 줄
**저장소 공개됨** https://github.com/PBJ-2/clauderipple (GPL-3.0, 09-13 밤). 디씨 두 곳에 글 올라감(AI활용갤 5추, 특갤).
릴리스 파일은 **아직 없음**(주군 완성 선언 전 빌드 금지) → README에 "소스 설치" 안내만. 실전 라우터는 저장소 소스로 가동 중,
테스트 114개 통과, HEAD는 `git log -1`. 가장 많이 들어온 요구는 **Windows**(댓글 3명).

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
- **자체 ChatGPT 어댑터 실전 가동**(proxenos 미사용). 오늘 잡은 문제 둘(둘 다 해결, ARCHITECTURE §4a):
  1. 400 `No tool call found…`의 진짜 원인은 Claude Code의 **서버측 스레드**(`thread: continue` + 새 메시지만 전송). 라우터가 continue를 `thread_unsupported_request`로 거절하면 CLI가 그 세션을 무상태로 전환한다. 부수 원인인 고아 tool_result는 user 텍스트로 보낸다.
  2. 캐시 17%의 원인은 시스템 블록 첫 줄 `x-anthropic-billing-header … cch=<해시>`가 매 턴 바뀌는 것. 제거 후 연속 턴 94–99%.
  `providers.chatgpt.debugDump`는 true(실패만 덤프) / "all"(전부, 최근 60개). 실전 config는 지금 true.
- **토큰 표시**: CLI는 스트리밍 블록마다 usage 스냅샷을 찍으므로 message_start에 입력 토큰 추정치를 넣었다(실측값은 message_delta). 앱 패널 숫자가 실제에 가깝게 나오는지 다음 서브에이전트 실행에서 확인.
- **agent-title 훅**(서브에이전트 제목에 모델·강도): `clauderipple agent-title on|off`, 트레이 메뉴, `POST /api/agent-title`. GUI 토글은 아직 없음.
- **GUI 전면 개편**(비개발자용, 프리셋·연결 확인·드롭다운 매핑) 커밋 ce1f9d6. 프리셋 카탈로그 `packages/router/src/presets.ts`(공식 문서 URL 주석). Grok·Mistral은 OpenAI 방식만이라 번역기 필요 → 미지원. 새 GUI는 격리 라우터에서 흐름 검증했고 실제 앱 창 스크린샷 검증은 못 했다(화면 접근 거부됨) — 주군이 직접 보고 어색한 문구·동작을 알려주면 고친다.

## 2026-09-13 밤 (릴리스 직전 상태)
- **호환 계층**(`packages/router/src/compat.ts`): Anthropic 호환 프로바이더로 나갈 때 thinking.block_binding/adaptive, context_management,
  defer_loading, server tools, anthropic-beta 헤더를 떼거나 바꾸고 effort를 프로바이더 caps에 맞춰 클램프. OpenRouter의
  DeepSeek·NVIDIA 무료 모델로 실제 Claude CLI(`claude -p --model …`)가 "ok"를 받는 것까지 실측.
- **프로바이더 URL의 경로 접두어**를 잃던 버그 수정(OpenRouter /api, DeepSeek /anthropic). 연결 확인은 통과하는데 실사용만 깨졌던 이유.
- **effort 메타데이터** `GET /api/effort-levels`; GUI는 모델별 유효 단계만 보여줌. Claude(패스스루)는 low/medium/high/max, GPT Luna만 ultra.
- **새로 추가한 피커 모델은 새 세션부터** 인식(CLI가 세션 시작 시 additional_model_options로 목록 고정). GUI 문구에 반영.
- **앱**: 자체 완결형(앱 안의 Node로 라우터 실행, 소스 동봉). `npm run dist`는 `release-dev/`, 서명·공증 릴리스는
  `APPLE_KEYCHAIN_PROFILE=clauderipple-notary npm run release`(키체인 프로필은 주군 키체인에 저장됨) → `release/*.dmg|zip`.
  주군 맥의 실전 라우터는 **저장소 소스**로 다시 돌려 놓았다(`node packages/cli/src/index.ts install`); 앱의 "설정 다시 실행"을
  누르면 앱 번들 사본으로 바뀌므로 개발 중엔 누르지 말 것.
- GitHub 공개 완료: https://github.com/PBJ-2/clauderipple (커밋 이메일은 noreply로 재작성됨; git config user.email 설정됨). 남은 것: Windows, 프리셋 실키 검증(ChatGPT·OpenRouter만 실측).

## 2026-09-13 밤 2 — M4 완료
- **OpenAI 입구**(`packages/router/src/ingress`, 포트 8793): Codex CLI가 `clauderipple codex on`으로 우리 라우터를 향하고 Claude를
  구독 로그인으로 쓴다. 실측: `CODEX_HOME=/tmp/… codex exec --profile clauderipple -m claude-haiku-4-5-20251001 "Reply ok"` → "ok".
  구독 자격증명 우선순위: 프록시 트래픽에서 관찰(메모리, 12h) → env → 키체인 → ~/.claude/.credentials.json → `<home>/claude-auth.json`(setup-token).
  **라우터 재시작 직후엔 관찰 토큰이 없어 Code 탭 요청이 한 번 지나가야 한다**(파일 지속화 추가 예정/완료 여부는 git log 확인).
- **openai-compatible 프로바이더**(`providers/openai`): Grok·Mistral·Groq·Together·Fireworks·Ollama·LM Studio 프리셋. 실키 검증 없음(401 경로만).
- **모델별 effort**: OpenRouter `supported_parameters`로 모델별 강도 지원 저장·표시·클램프.
- 실전 라우터는 저장소 소스로 실행 중. 앱은 "설정 다시 실행"을 누르면 번들 사본으로 바뀜.
- **Codex→Claude 429의 원인(09-13 심야, 실측)**: 구독 로그인으로 보낼 때 `system`에 Claude Code 정체성 한 줄 외의 긴 텍스트(Codex
  instructions)가 있으면 Anthropic이 `rate_limit_error: "Error"`(429)를 낸다. 진짜 한도가 아니다. 해결: `system`은 정체성 한 줄만,
  클라이언트 instructions는 첫 user 블록 `<operator_instructions>`로(캐시 마킹). Haiku 4.5는 `output_config.effort`를 400으로
  거부 → `claudeSupportsEffort()` 모델에만 보냄. 실측 Sonnet 5·Haiku 4.5 200, `codex exec -m claude-sonnet-5` exit 0.
  주군의 실제 `~/.codex/config.toml`에 `clauderipple` 프로바이더가 적용됨(백업 `config.toml.clauderipple-backup-2026-09-13T11-45-25-816Z`).
- 저장소는 **비공개로 전환**됨(주군: "다 완성해야 올리지", "멋대로 빌드하지 마라"). 주군이 완성 선언 전엔 릴리스 빌드·공개·태그 금지.
- README 스크린샷: picker-zoom·luna-answer·subagents 확보. 4번(Codex가 Claude로 답하는 터미널)은 429 수정 후 재촬영 대기.
- **Codex 앱 지원(09-13 밤)**: `codex on`이 `~/.codex/clauderipple-models.json` 카탈로그를 쓰고 `model_catalog_json`으로 가리킨다(Codex 앱 목록에
  Sonnet 5 등 실제 이름으로 뜸). env_key 제거, 입구는 Authorization 없어도 받음. **주군의 실제 config.toml 상단 `model`/`model_provider`가
  clauderipple/claude-sonnet-5로 임시 변경돼 있음** — 촬영 끝나면 되돌리거나 GPT 통과 기능을 넣을 것.
- **Codex 앱에서 관찰된 미해결 버그(주군: "나중에")**: ① 카탈로그 context_window 200000 고정 → Sonnet 5는 1M(모델별 값 필요).
  ② Claude가 Codex 지시문의 `exec_command`를 부르는데 도구는 `custom_exec_command`로 보냄(toClaudeCodeToolName 접두어가 모델에 노출) →
  첫 호출 실패 후 재시도. 지시문 쪽 이름을 바꾸든가 접두어 없이 보내는 방안 검토. ③ 관찰 토큰 만료 시 401 "OAuth access token has expired"를
  그대로 노출 — 만료 관찰 토큰은 버리고 키체인/파일 소스로 폴백해야 함.
- **GPT 통과 미구현**: Codex는 프로바이더가 전역 하나라, clauderipple이 기본이면 목록의 GPT 항목은 400(unsupported_provider). 입구에서
  gpt-* 요청을 chatgpt.com/backend-api/codex/responses로 그대로 통과(auth.json 토큰+chatgpt-account-id)시키면 한 목록에서 둘 다 쓸 수 있다.

## 주군이 직접 할 일 (세션이 못 함)
- **피커 모드 켜기**(아직 안 하심): 메뉴 막대 ClaudeRipple 아이콘 → "Code 탭 피커에 GPT 모델 이름 표시…"
  (또는 GUI 상태 화면의 "모델 피커" 카드 버튼, 또는 터미널 `clauderipple picker on`) → macOS 암호 창(키체인 신뢰)
  → **Claude Desktop 완전 종료 후 재실행** → Code 탭 피커에 GPT-5.6 Terra/Sol/Luna, GPT-6 Astra가 보이는지 확인.
  라우터 재시작은 필요 없다(config 핫리로드). 되돌리기는 같은 메뉴의 "끄기". 앱은 `/Applications/ClaudeRipple.app`
  (빌드 원본 `packages/app/release/mac-arm64/`).
- proxenos 데몬(8787)·프로토타입(8790) 정리는 주군 확인 후.

## 다음 세션이 할 일 (우선순위순, 09-13 밤 기준)
1. **Windows 지원(M5)** — 디씨 반응에서 가장 큰 요구. 막힌 것: launchd(→ 작업 스케줄러/로그인 실행), 인증서 생성이 `openssl` CLI 의존
   (→ 순수 JS ASN.1 서명 또는 번들 openssl), 피커 모드의 키체인 신뢰(→ certutil)와 Claude-3p 경로(`%APPDATA%`), Electron 윈도 빌드·코드서명.
   추산 이틀. 라우터 코어(TS)는 그대로 돈다.
2. **첫 서명 릴리스**(주군 "완성" 선언 후에만): `env -u HTTPS_PROXY APPLE_KEYCHAIN_PROFILE=clauderipple-notary npm run release` →
   원격의 낡은 `v0.1.0` 태그(MIT 시절 커밋) 삭제 후 재태그 → `gh release create` DMG/ZIP → README 설치 절의 "아직 릴리스 없음" 문장 제거.
3. **Codex 앱 버그 셋**(주군: "나중에"): ① 카탈로그 context_window 200000 고정(Sonnet 5는 1M → 모델별), ② 지시문 `exec_command` vs 도구
   `custom_exec_command` 불일치로 첫 도구 호출 실패, ③ 관찰 토큰 만료 시 401 그대로 노출(키체인/파일 폴백 필요).
4. **GPT 통과**: Codex 프로바이더는 전역 하나라 clauderipple이 기본이면 목록의 GPT 항목이 400. 입구에서 gpt-*를
   chatgpt.com/backend-api/codex/responses로 그대로 통과(auth.json 토큰 + chatgpt-account-id)시키면 한 목록에서 둘 다 됨.
   **그전까지 주군 `~/.codex/config.toml` 상단 `model = "claude-sonnet-5"` / `model_provider = "clauderipple"`는 임시 상태** —
   되돌리려면 백업 `config.toml.clauderipple-backup-20260913T211003`의 `model = "gpt-5.5"`로, `model_provider` 줄 삭제.
5. README 스크린샷 4번(Codex 앱에서 Claude가 답하는 장면) 미확보. `docs/media/codex-claude.png`는 답 없는 중간 장면이라 README에 안 넣음.
6. 프로토타입(8790)·proxenos(8787) 해제는 주군 확인 후.

## 09-13 밤 3 — 공개 직전에 한 일 (git log로 확인 가능)
- Codex→Claude 429 원인·수정(instructions를 첫 user 블록으로, effort 게이트), 완료 후 소켓 끊김을 200으로 기록, env_key 제거·Authorization 선택.
- **Codex 모델 카탈로그**(`model_catalog_json`): 형식은 Codex 파싱 오류를 하나씩 읽어 알아냄 — `{models:[…]}`, 항목마다 `base_instructions`·
  `supports_parallel_tool_calls` 필수, `model_messages.instructions_template`이 있으면 그것이 시스템 프롬프트. gpt-5.5 항목 복제로 생성.
  라우터가 설정 변경 시 자동 갱신(`codexEnabled()`일 때만).
- GUI `?lang=en` 지원 → `scripts/make-media.mts`가 영어로 캡처. README 영/한 전면 개정(비교표·알파 섹션·언어 링크), 라이선스 GPL-3.0.
- 디씨 댓글 "밴 아님?"에 대한 정확한 답: Claude Code→GPT는 문서화된 프록시 경로라 Claude 요청은 무변경. ChatGPT 구독을 Codex 백엔드로 빌리는 것과
  Claude 구독을 Codex에서 재사용하는 것은 각사 약관 회색지대(README엔 "약관의 적용을 받는다"만 적음).

## 검증 명령
```bash
cd ~/Documents/ClaudeRipple && npx tsc -p tsconfig.json --noEmit && npm test
node packages/cli/src/index.ts status
tail -20 ~/.clauderipple/logs/router.log
```
테스트는 `CLAUDERIPPLE_HOME`·`CLAUDE_SETTINGS_PATH`로 격리한 임시 홈에서만. 외부 네트워크가 필요한 실측은
`dangerouslyDisableSandbox`. 격리 라우터는 `CLAUDERIPPLE_HOME=<임시홈> node packages/router/src/index.ts`로 8793 등 다른 포트에 띄우고
**포트·PID로만** 죽인다. 실전 라우터는 `clauderipple restart` 외의 방법으로 죽이지 말 것.
