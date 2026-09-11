# 인수인계 — 2026-09-11 저녁

> 다음 세션이 처음 읽을 문서. 기술 근거는 `docs/ARCHITECTURE.md`, 규칙은 `CLAUDE.md`,
> 메모리는 `~/.claude/projects/-Users-pbj-Downloads/memory/clauderipple-project.md`.

## 지금 상태 한 줄
ClaudeRipple(클로드리플)은 **주군 데스크톱에서 실전 가동 중**이다. 라우터·CLI·ChatGPT 어댑터·한국어 GUI·
메뉴 막대 앱·피커 모드가 전부 코드로 있고 테스트 38개가 통과한다. 커밋 14개, `main` 브랜치, 원격 없음.

## 실전 환경 (건드리기 전에 알 것)
| 항목 | 값 |
|---|---|
| 저장소 | `~/Documents/ClaudeRipple` (TypeScript, Node 24 타입 스트리핑, 빌드 없이 `node file.ts`) |
| 홈 | `~/.clauderipple/` — config.json, ca/leaf 인증서, `chatgpt-auth.json`(없음), `paths.json`, logs/ |
| 라우터 | launchd `com.clauderipple.router`, 포트 **8791**, 관리 GUI **8792** (`ClaudeRipple.app` 런처 번들로 실행) |
| settings.json | `HTTPS_PROXY=http://127.0.0.1:8791`, `NODE_EXTRA_CA_CERTS=~/.clauderipple/ca.pem`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000` |
| 프로토타입 | `~/.local/share/claude-router/` 파이썬, 포트 8790, **켜져 있으나 미사용**. 되돌리기 = settings의 프록시 주소를 8790으로 |
| 프로바이더 | config의 `chatgpt`는 아직 **anthropic-compatible → proxenos(8787)**. 자체 어댑터는 코드만 완료 |
| 백업 | `~/.claude/settings.json.bak-clauderipple-20260911T074058` |

## 오늘 확정된 사실 (재조사 금지)
- 공식 3P 게이트웨이 설정은 앱 전체 모드 전환이라 claude.ai 채팅·Remote Control을 잃는다. 우리는 아무것도 안 잃는다.
- 프록시 env를 읽는 건 CLI 자신. 앱은 CLI를 4시간마다 따로 자동 갱신한다. 피닝 없음.
- 피커 목록 원천 = claude.ai 부트스트랩 `/edge-api/bootstrap[/{org}/app_start]?...`의 `model_selector_config`. 앱은 id 검증 없이 CLI에 넘긴다.
- 앱은 자기 Config Library(`~/Library/Application Support/Claude/configLibrary/`)의 `egressProxyUrl`을 시작 시 Chromium `--proxy-server`로 건다. → 피커 모드의 근거.
- OpenClaude는 33K 스타 프로젝트가 있어 이름 불가. ClaudeRipple로 확정. Claude 상표 위험은 낮다고 판단(면책 문구 유지).
- proxenos는 Apache-2.0(husniadil/proxenos). **코드 복사 금지, 동작 명세로만 참조.** 어댑터는 자체 구현 완료.

## 오늘의 사고 (재발 방지)
1. 17:00 내가 라우터를 재시작해 진행 중 요청 5개가 끊김 → 주군 앱에 오류. **드레인 구현**(SIGTERM 시 모델 호출 최대 45초 대기). 지금 실전 라우터에 올라가 있다.
2. 한국어화 에이전트가 `pkill -f "packages/router/src/index.ts"`로 실전 라우터를 4번 죽임(17:25). launchd가 살렸다. **서브에이전트에 프로세스 정리를 시킬 땐 포트·PID로만 죽이라고 명시할 것.**
3. 조사 에이전트 모델을 안 적어 페이블이 상속됨. **폴백 Claude 에이전트는 `model: sonnet` 명시.**

## 주군이 직접 할 일 (세션이 못 함)
- **피커 모드 켜기**: 터미널에서 `cd ~/Documents/ClaudeRipple && node packages/cli/src/index.ts picker on`
  → macOS 암호 창(키체인 신뢰) → 라우터 자동 재시작 → **Claude Desktop 완전 종료 후 재실행** → Code 탭 피커에
  GPT-5.6 Terra/Sol/Luna, GPT-6 Astra가 보이는지 확인. 되돌리기 `picker off`.
- 모바일 원격 전송은 오늘 정상 확인됨.

## 다음 세션이 할 일 (우선순위순)
1. **피커 모드 실전 검증**: `grep "PICKER" ~/.clauderipple/logs/router.log`. `PICKER injected N; surfaces: chat[..] xxx[..]`가
   찍히면 surface id를 확인. 안 뜨면 (a) 앱이 프록시를 안 탔는지(`grep "WEB claude.ai"`), (b) 부트스트랩 경로가
   다른지, (c) 렌더러가 id를 거르는지 순으로 본다. 휴리스틱은 `packages/router/src/picker.ts`(chat 제외 전부 주입).
2. **9월 15일 이후 GPT 주간 한도 초기화되면** 자체 ChatGPT 어댑터로 전환: config `providers.chatgpt`를
   `{"type":"chatgpt","auth":"borrow-codex","instructionsAppend":"<proxenos config.toml의 append 문구>"}`로 바꾸고
   실제 스트리밍·도구 호출·캐시 적중(≥90%, 로그 `cached=` 값)을 확인. 통과하면 proxenos 의존 제거.
3. GUI에 피커 모드 상태 표시(admin `/api/status`의 `picker` 필드는 이미 있음, UI만 없음). 메뉴 막대 앱 한국어 빌드
   재생성(`cd packages/app && npm run dist` → `release/mac-arm64/ClaudeRipple.app`).
4. README 영어 마무리, GitHub 공개 준비(원격 없음), 스크린샷.
5. 프로토타입(8790) launchd 해제는 주군 확인 후.

## 검증 명령
```bash
cd ~/Documents/ClaudeRipple && npx tsc -p tsconfig.json --noEmit && npm test
node packages/cli/src/index.ts status
tail -20 ~/.clauderipple/logs/router.log
```
테스트는 `CLAUDERIPPLE_HOME`·`CLAUDE_SETTINGS_PATH`로 격리한 임시 홈에서만. 외부 네트워크가 필요한 실측은
`dangerouslyDisableSandbox`. 실전 라우터는 `clauderipple restart`(드레인됨) 외의 방법으로 죽이지 말 것.
