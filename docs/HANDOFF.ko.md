# 인수인계 — 2026-09-16 (최신)

> 다음 세션이 처음 읽을 문서. 기술 근거는 `docs/ARCHITECTURE.md`, 규칙은 `CLAUDE.md`,
> 릴리스 절차는 `docs/RELEASE.md`.

## ▶ 2026-09-16 (오후) — 배포를 npm으로 바꿨다

**왜.** 릴리스마다 맥에서 서명·공증, Windows VM에서 별도 빌드(arm64 NSIS는 실행 파일을 빼먹는 고장 상태),
파일 네 개 수동 업로드. 주군 판단으로 이 부담을 없애고 npm 단일 경로로 갔다.

**구조.**
- 루트 `package.json`이 게시 패키지(`clauderipple`)다. `bin/clauderipple.js`가 진입점.
- **`node_modules` 아래의 .ts는 Node가 실행하지 않는다**(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
  직접 받아 보고 알았다). 그래서 `scripts/build-npm.mjs`가 `dist/`로 JS를 굽는다. 배치는 소스와 같은 모양이고
  한 단계만 다르다(`packages/cli/src` ↔ `dist/cli/src`). `runtime.ts`가 **자기 파일의 확장자**로 어느 배치인지
  판별하므로 체크아웃·npm·패키지 앱 셋 다 같은 코드로 돈다.
- `schtasks.agentPid()`의 매칭을 `router\src\index.` 로 넓혔다. 안 그러면 npm 설치본에서 `restart`가 또
  거짓 보고한다.
- 트레이는 `clauderipple tray`. Electron은 **의존성이 아니다**(270MB). `tray --install`이 그때 받아 온다.
  기본 설치 828KB, 0.2초. Electron 받은 뒤 기동까지 실측 확인.

**설치 스크립트.** `scripts/install.sh`(macOS·Linux), `scripts/install.ps1`(Windows). GitHub raw로 제공하므로
호스팅이 필요 없다. PATH에 Node 24+가 있으면 그대로 쓰고, 없으면 nodejs.org 공식 빌드를
`~/.clauderipple/runtime`에 받아 **SHASUMS256.txt와 대조한 뒤** 푼다. 버전은 `dist/index.json`에서 최신 24.x를
조회하고 실패 시에만 스크립트의 핀(v24.21.0)을 쓴다.

**함정 둘 (실측으로 잡았다).**
1. `download_node`가 `say`로 진행 상황을 stdout에 찍는데 `NODE="$(download_node)"`로 받으면 그 문구가 경로에
   섞인다. 결과를 stdout으로 돌려주지 말고 약속된 위치(`$RUNTIME/bin/node`)에 두게 고쳤다.
2. npm이 만드는 명령 링크의 셔뱅은 `env node`다. **우리가 받은 Node가 그 컴퓨터의 유일한 Node면 PATH에 없어서
   명령이 시작조차 안 된다.** 설치는 성공하고 실행만 안 되는, 가장 나쁜 형태. Node를 우리가 받은 경우에는
   그 Node를 직접 가리키는 래퍼 스크립트로 교체한다.

**검증한 것 (macOS arm64).** Node 없는 환경(`env -i`)에서 다운로드→체크섬→설치→실행까지, Node 있는 환경에서
건너뛰기, 격리 홈·포트로 `install`(인증서·설정·launchd·라우터·종단 프로브)→대시보드 200→`uninstall --purge`,
`tray --install`→`tray` 기동.

**검증 못 한 것.**
- **`scripts/install.ps1`은 한 줄도 실행해 보지 못했다.** 이 맥에 PowerShell이 없다. 문법 검사조차 못 했다.
  Windows에서 첫 실행 시 반드시 손으로 확인할 것. 특히 ① `npm install --global --prefix`가 Windows에서는
  명령을 prefix 루트에 두는 것(`$Prefix\clauderipple.cmd`)을 전제로 했는데 맞는지, ② 사용자 PATH 등록,
  ③ `irm | iex` 실행 정책.
- npm에 **아직 게시하지 않았다.** 주군 승인 대기.
- Windows에서 npm 설치본의 작업 스케줄러 등록·재시작 동작.

## ▶ 2026-09-16 — 0.1.1이 Windows 신고자에게 안 먹힌 이유와 0.1.2 (미배포)

디씨 댓글(thesingularity 1422778)의 Windows 사용자는 0.1.1을 받고도 DeepSeek 401이 그대로였다.
GitHub의 0.1.1 zip을 직접 받아 확인: 헤더 수정·Haiku 수정 **전부 들어 있다.** 원인은 코드가 아니라
**떠 있는 라우터 프로세스가 구버전**이었던 것 — 파일만 갈리고 프로세스는 아무도 안 바꿨다
(`start`는 떠 있으면 손대지 않음, zip을 새 폴더에 풀면 작업 스케줄러·paths.json이 옛 폴더). 라우터가
버전을 "0.1.0"으로 하드코딩해 보고했기 때문에 구분도 불가능했다. 사용자가 본 새 문구
"setup-token failed"는 새 CLI 파일이 실행된 증거이고, 401은 옛 라우터의 것.

0.1.2에서 한 것(CHANGELOG 참고): `version.ts` 단일 상수 + 매니페스트 대조 테스트, `/api/status.runtime`,
앱의 `reconcileRouter()`(버전·경로 불일치 시 install→restart, 앱 실행당 1회, 체크아웃 기록은 불건드림),
프로바이더 4xx/5xx 본문 로그(마스킹), setup-token 비-TTY 안내. 테스트 141개 통과, 앱 tsc 통과.

**macOS 실측 완료 (2026-09-16 10:58):** `/Applications/ClaudeRipple.app`(0.1.0, ad hoc 서명)을 `npm run dist`로 만든
0.1.2 번들로 교체하고 앱을 띄우자 5초 안에 라우터 0.1.0을 감지 → SIGTERM 드레인 7초 → 0.1.2로 재기동.
`/api/status.runtime.router`가 새 번들, `/readyz` 200, `/api/claude-oauth` 응답. 주군 라이브 라우터가 이제 0.1.2다.
(주의: 주군 맥의 `paths.json`은 이제 소스 체크아웃이 아니라 `/Applications` 앱을 가리킨다. 체크아웃을 고친 뒤
실측하려면 다시 `npm run dist` → 번들 교체.)

**검증 안 된 것 (다음에 할 일):**
- `reconcileRouter()`의 **Windows VM 실기 검증**은 아직이다. 시나리오 둘:
  ① 0.1.1 exe 설치 상태에서 0.1.2 exe 설치 → 앱이 알림 띄우고 라우터 버전이 0.1.2로 바뀌는지.
  ② 0.1.1 zip 폴더 A에서 라우터가 도는 상태로 0.1.2 zip을 폴더 B에 풀고 B의 앱 실행 → install+restart 후
  `/api/status.runtime.router`가 B를 가리키는지.
- **DeepSeek 직결은 실키로 검증된 적이 없다** (실키 검증은 ChatGPT·OpenRouter뿐). 라우터 재시작 후에도 401이면
  이제는 로그에 DeepSeek의 본문이 남으니 그것부터 본다. DeepSeek 키 하나 사서 종단 테스트를 하는 게 정석.
- **Windows 패키지에서 `restart`는 원래부터 아무것도 안 했다** (독립 리뷰가 잡음): `schtasks.agentPid()`가
  `node.exe`만 찾는데 패키지 라우터는 `ClaudeRipple.exe`로 돈다 → PID 없음 → shutdown 생략 → 이미 도는 작업이
  Start 요청을 무시(IgnoreNew) → "restarted"라고 거짓 보고. 0.1.2에서 두 이름 다 매칭. 그래서 0.1.1 사용자에게
  "트레이 재시작"은 답이 아니다. **당장 줄 답: 로그아웃→로그인(또는 재부팅) 후 다시 시도.** 그래도 401이면
  진짜 DeepSeek 문제.
- 오류 본문 마스킹은 `packages/router/src/redact.ts`(+ `test/redact.test.ts`)로 통합됐다: 실제로 내보낸 자격증명
  헤더 값을 그대로 치환하고(벤더별 키 형식 무관), Bearer·`sk-…`·JWT·`api_key=…` 패턴도 가린다. anthropic-compatible
  프록시뿐 아니라 openai-compatible·ChatGPT 어댑터·OpenAI ingress의 업스트림 오류 로그에도 적용.
  (이 부분은 "조사만 하라"고 보낸 GPT 서브에이전트가 지시를 어기고 저장소를 고친 결과다 — CLAUDE.md의
  지시 유실 경고 그대로. 내용은 검토 후 채택했고 테스트 142개 통과. 다음에도 조사 위임 후 `git status`를 확인할 것.)

**오픈코덱스 해부 후 같은 날 추가한 것 (커밋 2건째):**
- **Claude 구독 브라우저 로그인** `packages/router/src/providers/claude-oauth.ts`: Claude Code 공개 클라이언트로 PKCE
  OAuth. 콜백은 `localhost:54545/callback`, 포트가 막히면 Anthropic의 코드 표시 페이지 → `code#state` 붙여넣기.
  파일은 `<home>/claude-auth.json` `source:"oauth"`(access+refresh+expiresAt), 인그레스가 만료 5분 전에 자동 갱신
  (`ClaudeCodeAuthStore.refreshIfNeeded`, 동시 호출 1회 공유). GUI는 `POST/GET /api/claude-oauth`,
  `POST /api/claude-oauth/code`, `/cancel`. CLI `claude-login`이 기본 이 흐름, `--setup-token`이 옛 경로.
  **2026-09-16 14:00 실측 성공 (주군 맥, claude.ai 계정).** 두 가지를 고치고 나서다.
  ① authorize/token 엔드포인트를 Claude Code 2.1.272 바이너리에서 그대로 읽어 교체했다
  (`claude.com/cai/oauth/authorize`, `platform.claude.com/v1/oauth/token`,
  수동 리다이렉트 `platform.claude.com/oauth/code/callback`). 옛 `claude.ai/oauth/authorize`는
  "인증 실패 / Invalid request format"이 떴다.
  ② state를 16바이트에서 32바이트로 늘렸다 — CLI는 verifier와 state 둘 다 32바이트다.
  authorize URL의 파라미터 이름·순서·스코프 목록은 CLI의 생성 함수와 대조해 동일함을 확인했다.
  수동 모드 리다이렉트가 이 클라이언트에 등록돼 있는지는 여전히 미실측이다.
  **로그인이 성공해도 프로바이더 카드의 출처 줄은 안 바뀐다**: Claude Desktop 세션(observed)이
  우선순위가 높기 때문이다. 그래서 probe/status가 `signedIn`을 따로 보고하고 화면이 별도 줄로
  "ClaudeRipple 로그인도 저장돼 있습니다"라고 말하게 했다.
  (옛 기록)  — 토큰 엔드포인트는 스텁으로만 검증. 주군이 맥에서 GUI 버튼 한 번 눌러
  실측할 것 (claude.ai 로그인 → 콜백 → 프로바이더 카드 "ClaudeRipple 토큰"). 수동 모드(포트 점유 시)의 리다이렉트
  `console.anthropic.com/oauth/code/callback`이 이 클라이언트에 등록돼 있는지는 Claude Code의 동작으로 미루어
  짐작한 것이라 그것도 실측 대상.
- **readiness** `/readyz`·`status.readiness.problems` (settings·upstream·picker-ca·picker-proxy·provider:<name>),
  트레이 상세 줄에 표시. 인증서 신뢰 조회는 60초 메모.
- 프로바이더가 HTML을 주면 "HTML page … not an API"로 기록.
- ⚠️ 테스트에서 `claude-login`을 `--setup-token` 없이 돌리면 **진짜 브라우저가 열린다** (한 번 그랬다, 5분 대기 후
  실패). 테스트는 반드시 `--setup-token`으로.

**Windows 릴리스 빌드는 이 맥에서 못 만든다** (RELEASE.md: Windows에서 빌드). 0.1.2 태그·릴리스는 VM에서.

## ▶ 2026-09-14 밤 — 아래 4건 전부 처리됨 (실기 검증 완료)

- **1. GUI ChatGPT 로그인 버튼** — `POST/GET /api/chatgpt-login`(비동기, admin.ts), 상태 카드·프로바이더 카드·수정 폼에
  버튼 + 2초 폴링. 격리 라우터에서 fetch 스텁으로 흐름 실측. 실제 OAuth는 주군이 눌러 봐야 한다(트레이 메뉴 경로는 검증됨).
- **2. 언어** — `main.ts` `uiLang()`: `getPreferredSystemLanguages()[0]` → `getSystemLocale()` → `getLocale()`. GUI는
  `?lang=<OS언어>`로 열고, `i18n.js`는 **localStorage(토글) > ?lang > navigator.language** 순. 주군 실기에서 실제로
  영어로 떴는지는 재확인 못 했다(렌더러 cmdline이 `--lang=ko`였다). 트레이 앱 재실행 후 확인할 것.
- **3. 피커** — 진짜 원인은 "켜진 적 없음"(아래 3번 항목). 수정·검증 완료.
- **4. 인스톨러** — `packages/app/build/installer.nsh` + `stop-clauderipple.ps1`. `customCheckAppRunning`으로 stock 검사를
  감싼다: `schtasks /End` → `POST /api/shutdown` → 라우터 종료 대기 → 잔여 강제 종료. 실기: 라우터 돌던 중 재설치
  exit 0, 27초, 로그에 `shutdown requested … drain complete`, 작업·settings.json·피커 전부 보존.
  **밟은 함정 셋(전부 고침, 재발 금지):**
  ① `customCheckAppRunning`을 정의하면 electron-builder가 `getProcessInfo.nsh`·`Var pid`를 안 넣는다 → 직접 include.
  ② **업그레이드 설치는 이전 버전의 언인스톨러를 `--updated`로 실행한다.** 언인스톨러 훅에서 `clauderipple uninstall`을
  돌리면 재설치마다 작업·settings.json·피커가 날아간다(실측). `${isUpdated}`면 stop만.
  ③ PowerShell: 함수가 CimInstance 하나를 돌려주면 `(F).Count`가 **null**이다(`-gt 0` 거짓) → 호출부에서 `@(F).Count`.
  이것 때문에 드레인 없이 강제 종료되고 있었는데 exit 0이라 안 보였다. 로그의 `drain complete`로만 판별된다.
- 빌드: 맥 크로스 빌드(`packages/app/release-win/`), 인스톨러 실기 3회 설치. 드래프트 릴리스 에셋 교체:
  `ClaudeRipple-Setup-0.1.0-x64-b2120.exe`, `ClaudeRipple-0.1.0-win-{x64,arm64}-b2120.zip`.
- README(영/한)·CHANGELOG·RELEASE.md 갱신. README의 "아직 릴리스가 없습니다" 문장은 정식 공개 때 지울 것.

**릴리스 공개됨 (09-14 21:2x)**: https://github.com/PBJ-2/clauderipple/releases/tag/v0.1.0 — `v0.1.0`을 `fffc5c2`로
재태그(옛 MIT 시절 태그 삭제), 맥 arm64/x64 DMG·zip(서명+공증, DMG 자체엔 스테이플 안 됨 — 앱은 됨), Windows x64
인스톨러·zip, arm64 zip. 드래프트 릴리스는 삭제됨. 다음 릴리스는 `package.json` 버전을 올리고 `docs/RELEASE.md` 절차대로.
**남은 것**: Windows 타이틀바,
GitHub Actions 빌드, 앱 미재시작 감지, 피커 모델 0개 안내, 언인스톨러의 `picker off` 인증서 제거 창(무음 설치에선 안 뜸).
**주군 PC 상태**: 라우터는 작업 스케줄러로 돌고 있고 피커 켜짐. **트레이 앱은 테스트 중 종료됐으니 시작 메뉴에서
ClaudeRipple을 다시 열어야 한다.** SSH 열려 있음(아래 "주군 x64 실기 접근").

## (처리됨) 다음 세션이 할 일 — Windows 마무리 (미해결 4건)

**x64 Windows 실기에서 검증은 끝났다. 남은 것은 전부 "동작은 하는데 사용자가 막히는" 것들이다.**
주군이 실제로 설치하며 발견했고, 하나도 고치지 못한 채 세션이 끝났다. → **전부 위에서 처리됨.**

### 1. GUI에 ChatGPT 로그인 버튼이 없다
프로바이더 화면이 "로그인 필요"라고 띄우면서 **거기서 로그인할 방법을 주지 않는다.**
트레이 메뉴(`signInChatgpt`)에만 있다. → `packages/ui/app.js`의 프로바이더 카드에 버튼 추가,
admin에 로그인 트리거 엔드포인트가 필요하다(`runCli(["login"])`은 브라우저를 열고 최대 5분 대기하므로
비동기 처리 주의).

### 2. 트레이·알림·GUI가 한국어 Windows에서 영어로 뜬다
```ts
L = STRINGS[app.getLocale().startsWith("ko") ? "ko" : "en"];   // packages/app/src/main.ts
```
`app.getLocale()`은 Chromium 앱 로케일이라 OS가 한국어여도 `en-US`를 준다.
→ `app.getPreferredSystemLanguages()[0]`(Electron 24+) 또는 `app.getSystemLocale()`로 바꿀 것.
**GUI(`packages/ui/app.js`)의 언어 판정도 별도 로직이니 같이 확인.** 맥에서는 우연히 맞아서 안 드러났다.

### 3. ~~피커를 켜도 모델이 0개면 아무 말이 없다~~ → **진짜 원인은 반대였다 (09-14 밤, 실기에서 확인·수정)**
주군 PC를 SSH로 직접 보니 `config.json`에 `picker` 키가 **없었고**, CA도 신뢰 목록에 없었고, Config Library도
없었다. 즉 **피커 모드는 켜진 적이 없었다.** 주군은 프로바이더 수정 창의 "Claude 앱 피커에도 실제 이름으로 표시"
체크박스를 켜기로 알았는데, 그 체크는 `cli.extraModels`(어떤 모델을 보일지)만 저장하고 피커 모드 자체는 건드리지
않는다. 아무 안내도 없으니 사용자는 "켰는데 안 뜬다"가 된다.
- **수정(GUI)**: 피커 모드가 꺼져 있으면 체크박스 아래에 안내 문구, 저장 직후 "지금 켤까요?" 확인 → `togglePicker(true)`.
  격리 라우터에서 문구·확인 창까지 실측. 주군 Windows 설치본의 `resources\clauderipple\packages\ui\`에도 바로 넣었다
  (원본은 `*.bak-fable`).
- 켜기 자체는 admin API `POST /api/picker {enabled:true}`로 호출하니 인증서 창 → 신뢰 → Config Library → 플래그가
  한 번에 통과했고, 앱 재실행 후 `[egress-proxy] pinned to fixed proxy at 127.0.0.1:8790`, 3초 뒤 `PICKER injected 16`,
  피커에서 Terra 선택 → 호출 성공(주군 확인).
- **MSIX는 문제가 아니다.** 홈페이지 배포본도 `WindowsApps\Claude_…pzs8sxrjxfjjc`(MSIX)로 설치되고 AppData가
  `Packages\…\LocalCache`로 가상화되지만, 앱은 실제 `%LOCALAPPDATA%\Claude-3p\configLibrary`를 그대로 읽었다(merge 동작).
- 이 PC의 포트: 프록시 8790, **admin 8791**, ingress 8792 (`listen.port` 기본값이 8790이라 맥과 하나씩 다르다).
  `curl.exe … :8792/api/picker`는 ingress의 404가 나온다.
- 원래 적혀 있던 "모델 0개 안내"는 여전히 있으면 좋은 것이지만 이번 증상의 원인은 아니었다.

**주군 x64 실기 접근(09-14 밤 개통)**: OpenSSH 서버 켜 둠. `ssh -i ~/.ssh/clauderipple_win K@192.168.55.30`
(같은 공유기, 계정 `K`, 키 인증, 비밀번호 없음). 기본 셸은 cmd라 PowerShell은 **스크립트를 scp로 올려
`powershell -NoProfile -ExecutionPolicy Bypass -File x.ps1`로 실행**할 것 — 인라인 `-Command`는 따옴표와 한글이 깨진다.
스크립트의 정규식에 한글을 넣지 말 것(BOM 없이 읽혀 깨진다). 인증서 신뢰처럼 화면이 필요한 작업은 SSH 세션에서
직접 못 하고, 라우터 admin API를 통해 시키면 라우터(로그온 세션의 작업 스케줄러)가 화면에 띄운다.
Claude Desktop 로그: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude\logs\main.log`.

### 4. 인스톨러가 라우터를 내리지 않아 업데이트가 막힌다
재설치 시 "ClaudeRipple이 종료되지 않았습니다"가 뜨고 재시도해도 안 된다. 앱은 트레이에서 사라졌는데
**라우터가 `ClaudeRipple.exe`로 돌고 있어 파일이 잠긴다.** 사용자는 뭘 끄라는 건지 알 수 없다.
→ `build.nsis.include`에 `customInit` 매크로로 설치 전 정리:
`POST /api/shutdown` → 종료 대기 → `schtasks /End` → 남은 프로세스 종료. 그냥 taskkill하면 드레인이 잘린다.

**임시 우회**(사용자 안내용):
```powershell
Stop-ScheduledTask -TaskName ClaudeRippleRouter -EA 0
Get-Process ClaudeRipple -EA 0 | Stop-Process -Force
```

---

## Windows 검증 상태 (2026-09-14 기준)

| | arm64 VM | **x64 실기** |
|---|---|---|
| 인스톨러가 실행 파일 설치 | ❌ 실행 파일만 누락(122→114) | ✅ **정상** |
| 첫 실행 설정 안내 | — | ✅ (고친 뒤) |
| 인증서·settings.json·작업 등록 | ✅ | ✅ |
| 라우터 기동·크래시 복구 | ✅ (4.8초) | ✅ |
| ChatGPT 로그인 | ✅ | ✅ (트레이 메뉴로) |
| **피커에 모델 표시** | ✅ 12개 | ✅ 16개 (09-14 밤, 피커 모드를 실제로 켠 뒤) |
| 실제 모델 호출 | ✅ | ✅ Terra 응답 (주군 확인) |

**arm64 인스톨러 문제는 x64에 없다.** zip 전용으로 후퇴할 필요 없음.
(macOS 크로스 빌드도, Defender도 원인이 아니었다 — 둘 다 배제됨. NSIS 스텁이 x86이라
arm64에서 에뮬레이션으로 도는 것이 남은 가설이고, x64가 멀쩡하므로 실용적으로는 무시 가능.)

## ⚠️ Windows 빌드 시 반드시 지킬 것

오늘 주군을 **다섯 번** 재설치하게 만든 원인이다.

1. **`npx electron-builder`만 치지 말 것.** `main.ts`를 고쳐도 앱이 실행하는 건 `dist/main.js`다.
   반드시 `npm run build`(tsc)를 먼저. `tsc --noEmit`은 출력을 만들지 않으므로 통과해도 소용없다.
2. **올리기 전에 asar 안을 확인할 것.**
   ```bash
   node -e "const a=require('@electron/asar');console.log(a.extractFile('packages/app/release-win/win-unpacked/resources/app.asar','dist/main.js').toString().includes('<바꾼 문자열>'))"
   ```
   GUI·라우터 소스는 `resources/clauderipple/` 아래를 직접 grep.
3. **같은 파일명으로 덮어쓰지 말 것.** GitHub/브라우저 캐시로 옛 파일이 내려간다. `-b<HHMM>` 같은 표식을 붙이고,
   **옛 에셋은 지울 것**(`gh release delete-asset`).
4. **판별 기준을 상황에 맞게 줄 것.** "설정이 끝나지 않았습니다"는 `paths.json`이 없을 때만 뜬다.
   이미 설정을 마친 PC에서는 새 빌드여도 안 뜬다 — 이것 때문에 멀쩡한 빌드를 구버전으로 오인했다.

## 배포 중인 것

GitHub **draft** 릴리스(비공개): https://github.com/PBJ-2/clauderipple/releases/tag/untagged-6b9dcd30d6488801d95b
현재 에셋: `ClaudeRipple-Setup-0.1.0-x64-b2000.exe` (커밋 `4e1b46d` 시점).
위 4건을 고친 뒤 새 빌드로 교체하고, 확인이 끝나면 지우거나 정식 릴리스로 승격한다.

---

## 2026-09-14 — 기동 문제 수정 + **Windows 실기 검증 완료**

### 오전: 부팅 지연·표시·보안 (커밋 c776ac3, 42b629a, 411aa73, 844843c)
실제 사고에서 출발했다. 재부팅 후 **로그인 4분 뒤에야 라우터가 떴고**, 그동안 Claude Desktop은
`ERR_PROXY_CONNECTION_FAILED` 흰 화면이었다(피커 모드는 앱 트래픽 전량이 라우터를 지나므로
라우터가 느리면 앱이 죽은 것처럼 보인다 — 공식 문서상 직결 폴백이 없다).

- **launchd `ProcessType` Background → Interactive.** Background는 CPU·I/O를 스로틀한다(man launchd.plist).
- **`listen()`을 인증서 민팅보다 먼저.** 소켓이 먼저 열리면 클라이언트는 거절이 아니라 대기한다.
  모든 기동이 `startup Nms: node …, config …, listen …`을 찍는다.
- **`start`가 멱등적이 됐다.** 예전엔 `kickstart -k`라서 뜨는 중인 라우터를 죽이고 다시 기다리게 했다
  (로그인 후 4분 동안 runs=3의 정체).
- **트레이 앱**: 로그인 자동시작, 라우터 다운 시 원인을 설명하는 화면, 20초 후 알림.
- **openssl 제거** → `packages/router/src/x509.ts` (순수 `node:crypto`, 의존성 0). 기존 CA로
  발급·검증·TLS 핸드셰이크까지 실측 통과. **이 판단이 Windows에서 곧바로 값을 했다.**
- **admin API 교차 사이트 POST 차단.** 127.0.0.1 바인딩은 브라우저를 막지 못한다 — 아무 웹페이지나
  `POST /api/picker`를 보낼 수 있었다(CORS는 응답만 가린다). `Origin` 검사 추가.
- **`POST /api/shutdown`** 추가 (Windows엔 SIGTERM이 없다).
- 훅 자기경로 판별을 `fileURLToPath`로 (경로에 공백이 있으면 macOS에서도 조용히 죽었다).

### 오후: Windows 지원 (커밋 3a6be28) — **Parallels Windows 11 VM에서 끝까지 검증**
피커에 GPT 모델이 뜨고, 선택해서 호출하면 모델이 답한다:
`CHATGPT gpt-5.6-terra effort=high POST /v1/messages -> 200`.

| 항목 | Windows 구현 |
|---|---|
| 감독 | Task Scheduler (`schtasks.ts`), ONLOGON + RestartCount. **표준 사용자, UAC 없음** |
| 인증서 신뢰 | `Cert:\CurrentUser\Root`. 암호 대신 **지문 확인 창**, 관리자 권한 불필요 |
| Config Library | `%LOCALAPPDATA%\Claude-3p\configLibrary\` (`%APPDATA%` 아님) |
| 우아한 종료 | `POST /api/shutdown` (SIGTERM 없음) |
| 플랫폼 분기 | `supervisor.ts`가 launchd/schtasks를 고른다 |

**Windows에서 잡은 버그 넷 — 전부 "그냥 안 됐을" 것들이다:**
1. 콘솔 상속 → 설치 창을 닫으면 라우터가 `0xC000013A`로 죽음 → `Start-Process -PassThru -Wait`
2. `install`이 라우터를 시작 안 함 → 다음 로그인까지 안 뜸 (launchd는 RunAtLoad로 즉시)
3. `-NonInteractive` → 인증서 신뢰가 "UI를 사용할 수 없습니다"로 실패, 창이 안 뜸
4. `cmd /c start`가 OAuth URL을 첫 `&`에서 자름 → `missing_required_parameter`로 **로그인 불가**

### 저녁: 발표 준비 + x64 실기 검증 (커밋 46f1649 … 4e1b46d)
- **GUI 버그**: 모델 매핑이 모든 모델을 두 번 보여줬다(피커 스냅샷의 `code`·`ccd` 서페이스가
  같은 목록인데 합쳤다). 주입 *후* 스냅샷이라 우리 GPT id까지 매핑 **소스**로 떴다. 맥에서도 같은 버그.
- **창 크기**: 960px로 열렸는데 로그 테이블만 920px이 필요했다 → 1180×760, 최소 900.
- **Windows 메뉴바** 제거(Alt로만). 맥은 Cmd-Q가 거기 있어 유지.
- **KeepAlive**: Task Scheduler의 `RestartCount`는 **작업 시작 실패**에만 적용된다. 돌던 프로세스가
  죽으면 그냥 "완료"다(실측: 3분간 아무도 안 살림). 런처 PowerShell이 직접 감시하도록 바꿨고
  강제 종료 후 **4.8초 만에 자동 복구** 확인.
- **문서**: README·README.ko에 Windows 추가(서명 없음 경고, 앱 종료 함정), CHANGELOG,
  RELEASE.md에 Windows 절차.
- **코드 서명은 하지 않기로 결정**(주군). OV $219~400/년 + 하드웨어 토큰, EV $280~685/년,
  Azure의 월 $9.99는 **한국에서 가입 불가**. OV는 돈 쓰고도 SmartScreen 경고가 남아 최악.
  README에 "추가 정보 → 실행"을 명시했다.

**x64 실기에서 추가로 고친 것 (6a6a817, 1f9589f, 4e1b46d)**
- **첫 실행 설정 안내가 Windows에서 구조적으로 안 떴다.** `packagedRuntime()`이 macOS `.app` 경로만
  매칭해서 Windows에서 null → `needsSetup()`이 false. 설치하고 "라우터 꺼짐"만 보는 상태였다.
- **"라우터가 꺼져 있음"과 "설정이 안 됨"을 구분.** 설정한 적 없는 사람에게 전자는 고장처럼 읽힌다.
  설정 전에는 "라우터 시작" 대신 "설정 마치기"를 제안한다.
- **설정이 실패해도 "완료되었습니다"라고 했다** → 실패를 실패라고 말하게.
- **Windows 알림이 "Electron" 이름으로 떴다** → `setAppUserModelId`.
- **인증 없는 ChatGPT 프로바이더가 "연결됨"으로 떴고, 연결 확인은 무조건 성공을 반환했다.**
  reachable은 TCP 연결일 뿐이고 probe의 chatgpt 분기는 `ok: true` 고정이었다. 이제 둘 다 자격증명을
  본다(`needsLogin`, `chatgptSignedIn()`).

**남은 것**
- ⬜ **위 ▶ 미해결 4건** (GUI 로그인 버튼, 언어 판정, 피커 0개 안내, 인스톨러의 라우터 종료)
- ⬜ Windows 타이틀바 — 맥은 `titleBarStyle: hiddenInset`인데 Windows는 기본 창틀이라
  "오래된 프로그램" 느낌. 없애려면 `titleBarOverlay` + GUI에 드래그 영역·창 컨트롤 자리가 필요.
- ⬜ GitHub Actions(`windows-latest`) 빌드 — VM에 의존하지 않는 재현 가능한 릴리스 경로
- ⬜ 앱 종료 함정을 제품에서 감지하기 — 피커 모드면 라우터가 앱의 실제 경유 여부를 알 수 있으므로
  "설정은 됐지만 앱이 아직 재시작되지 않음"을 표시할 수 있다

**VM 운영 메모**: Parallels의 `Pause idle`이 켜져 있으면 작업이 계속 끊긴다
(`prlctl set "Windows 11" --pause-idle off --on-window-close keep-running`, 호스트 관리자 암호 필요 — 주군이 해뒀다).
`prlctl exec`에 PowerShell을 인라인으로 넘기면 따옴표가 벗겨진다 — **스크립트를 base64로 보내 파일로 실행할 것.**
`prlctl exec`가 반환 없이 매달리는 일이 잦다(4시간 넘게 남은 적 있음) — **작업 후 `ps | grep prlctl`로 정리할 것.**
Windows 바탕화면은 맥 `~/Desktop`과 공유돼 있다. PowerShell의 `Set-Content -Encoding UTF8`은 BOM을 붙이므로
JSON 파일을 그것으로 쓰지 말 것(`@electron/rebuild`가 파싱 못 해 빌드가 죽는다).

**VM에 남아 있는 것**: 주군 ChatGPT 토큰(`C:\Users\pbj\.clauderipple\chatgpt-auth.json`, 9/24 만료),
`C:\build\ClaudeRipple`(빌드용 사본), 테스트 설치 디렉터리 몇 개(`C:\cr-*`). 정리는 미뤘다.

---

## 이전 인수인계 (2026-09-13 밤)

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
  구독 자격증명 우선순위: 프록시 트래픽에서 관찰(메모리, 12h) → env → 키체인 → ~/.claude/.credentials.json → `<home>/claude-auth.json`(setup-token 또는 0.1.2부터 자체 OAuth, 자동 갱신).
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
7. README에 **GPT 서브에이전트 에이전트 파일 예시** 추가(`~/.claude/agents/gpt.md`, `model: gpt-5.6-terra`). 디씨에서 "하네스 따로 짜야 하냐"
   질문이 나옴 — 답은 "아니오, 에이전트 파일 하나". 주군의 `gpt`/`gpt-smart` 타입은 ClaudeRipple에 포함된 게 아니라 주군 개인 설정임.

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
