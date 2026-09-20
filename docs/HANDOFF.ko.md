# 인수인계 — 2026-09-20 (최신)

> 다음 세션이 처음 읽을 문서. 기술 근거는 `docs/ARCHITECTURE.md`, 규칙은 `CLAUDE.md`,
> 릴리스 절차는 `docs/RELEASE.md`, 경쟁 제품 대조는 `docs/OPENCODEX.md`.

## ▶ 2026-09-20 — 먼저 읽을 것

**1. 라이브 라우터에 오늘 코드가 전부 반영돼 있다.** 12:20과 12:26에 두 번 드레인 재시작했고
인플라이트 유실 없음. 재시작 직후 `~/.claude/agents/`에 **생성 파일 12개**가 떴다(아래 2번).

**2. 워커 정의는 이제 `config.json` 한 곳에서 파생된다 (`441cb3d`).** 프로바이더 하나만 선언한
체크된 모델마다 라우터가 `~/.claude/agents/<이름>.md`를 쓴다(`deepseek-v4.1-flash` →
`deepseek-v4-1-flash`). 소유 목록은 `~/.clauderipple/generated-agents.json`이고 **그 밖의 파일은 절대
안 건드린다.** 마커 별칭표는 `aliases` ∪ 에이전트 파일 `name→model`이라 **에이전트가 있으면 별칭도
있다.** 어제까지의 손 파일 `muse.md`·`gpt.md`·`gpt-smart.md`·`deepseek-flash.md`는 전부 중복이라
`~/.claude/agents.bak-20260920/`로 치웠다. **파세오식 `list_workers` MCP는 만들지 않는다** — 생성된
에이전트 파일이 Agent 도구 목록에 바로 뜨므로 그게 곧 조회다.

**3. 라우팅 불능은 이제 소리 내며 죽는다.** `claude-*`가 아닌 모델을 보낼 곳이 없으면 Anthropic에
PASS하지 않고 `400 ClaudeRipple: <사유>`로 거부한다(`unroutableReason`: 미선언 / 두 프로바이더 /
ingress 전용 / 모르는 마커 이름 / 미선언 모델로 풀리는 별칭). Claude 모델은 그대로 통과.

**4. 마커 규칙이 바뀌었다 (`60028ba`).** ① 유저 메시지 **맨 앞**에 있을 때만 인정 — 압축 요약에
인용된 마커가 세션을 엉뚱한 곳으로 보내던 것을 막았다. ② 마커가 모델을 바꾸면 **프로바이더도 그
모델 기준으로** 다시 정한다 — `gpt-6-astra` 세션이 `[[ripple: muse@high]]`를 ChatGPT에 보내던 구멍.

**5. ChatGPT 한도는 능동 조회한다.** `GET chatgpt.com/backend-api/wham/usage`(Codex CLI 바이너리에서
확인, 실호출 200; `/api/codex/usage`는 403). `/api/status`는 10분 넘으면 재조회, `?refresh=1`은 즉시,
시작 시 1회. 실측 41%. 프차리플이 이 값을 읽는다(옛 `proxenos usage` 대체).

**6. 옛 라우터 둘을 내렸다.** 파이썬 claude-router(8790)는 launchd에서 제거(`plist`는
`~/Library/LaunchAgents/disabled/`), proxenos(8787)는 종료 + 바이너리 `proxenos-disabled`. 둘 다 9/14
이후 요청 0건이었다. 관련 산문(전역 CLAUDE.md·에이전트 파일·프차리플 문서)도 전부 고쳤다.

**8. ChatGPT 프롬프트 캐시가 돌아왔다 (`2d6ca0e`, 라이브 검증).** 9/13 93% → 9/20 9%까지 떨어진 원인은
우리 요청이 아니라 백엔드였다 — 캐시를 `prompt_cache_key`가 아니라 **대화 정체성**(`session-id`/`thread-id`/
`x-client-request-id`/`client_metadata`)으로 키잉하기 시작했고 우리는 그걸 안 보냈다. 진짜 Codex CLI를 로컬
리버스 프록시(`chatgpt_base_url`, websocket 끔, `--ignore-user-config`)로 잡아 요청을 대조하고 요소별로
가른 결과다. 어댑터가 Codex와 같은 세트를 `conversationKey`에서 파생해 보낸다. 실측: 2턴 83.6%, 3턴+ 99.6%,
재시작 후 전체 95.5%. 캐시가 다시 떨어지면 **우리 기억이 아니라 진짜 CLI를 잡아서 diff**하라.

**7. 워커 우선순위(주군 지시, 전역 CLAUDE.md):** `deepseek-v4-1-flash` → `gpt-5-6-terra`(high) →
고지능 작업은 모델을 **제안하고 답을 받은 뒤** 띄운다. 뮤즈는 오늘 두 작업에서 40분간 코드 0줄이었고
딥시크 플래시는 각각 10·13분에 끝냈다.

**8. 신규 신고 #9·#10은 수정·검증·GitHub 정리까지 완료했다.** 신고자의 원래 커밋을 저자 그대로
체리픽했고(`351cd18`, `2e4a1b9`), 별도 하드닝 `bde04b2`에서 Remote Control 연결 재사용 누출과 Windows
작업 정의의 불완전 비교를 막았다. 전체 테스트 **276/276**, 타입 검사 통과. `main`에 푸시하고 실제 커밋
링크와 검증 결과를 댓글로 남긴 뒤 #9·#10, PR #11·#12를 닫았다.

**9. ChatGPT 구독 웹검색을 구현해 푸시했다(`e039419`).** `webSearch`가 ChatGPT 프로바이더를 명시할 때만
Codex Responses의 `web_search` 호스티드 툴을 쓴다. 실계정 호출로 검색 1회·URL 인용을 확인했고, 어댑터
단위 + 실제 CONNECT/TLS 프록시 종단 테스트가 통과했다. 설정이 없으면 기존 Haiku 검색 경로는 그대로다.
무자격증명 검색은 미완료다: DuckDuckGo HTML은 봇 차단, Instant Answer는 일반 검색이 아니며 Bing RSS는
공개 제품의 기본값으로 쓰기엔 이용 조건이 안전하지 않다.

**10. Homebrew Git은 제거했다.** Xcode 약관 수락 후 `/usr/bin/git` 2.54.0이 정상이라 임시 설치한 Homebrew
Git 2.55.0과 `/opt/homebrew/etc/gitconfig`를 삭제했다.

---

## ▶ 2026-09-20 — 오늘 밟은 함정 (전부 실측)

**1. "멈춘 세션"은 대개 조용한 404다.** 클로드리플2 세션이 하루 반 동안 턴마다 빈 응답으로 멈췄다.
라우터 로그를 보니 `[[ripple: deepseek@high]]`가 별칭표에 없는 `deepseek`로 풀려 Anthropic에 PASS →
404가 30건. 세션 화면엔 아무 사유도 안 뜬다. **워커가 멈추면 `requests.jsonl`에서 그 시각의
`provider`·`status`부터 봐라.**

**2. 진실이 네 곳에 있으면 빠뜨린 한 곳이 터진다.** `providers.models`·`aliases`·에이전트 파일·산문.
딥시크 하나 붙이는 데 넷을 손대야 했고 별칭 하나를 빠뜨렸다. 고친 방법은 "더 잘 적기"가 아니라
**세 곳을 한 곳에서 생성**하는 것이었다.

**3. 마커는 인용될 수 있다.** 압축 요약은 유저 메시지이고, 거기엔 지난 위임의 `[[ripple: muse@high]]`가
글로 남는다. 앵커 없는 정규식이 그걸 집었다. **본문 어디서나 찾는 마커는 결국 잘못된 곳에서 찾는다.**

**4. 프로바이더가 세션 모델을 따라가면 안 된다.** `gpt-` 접두사 규칙 분기가 마커 모델을 세션의
프로바이더(ChatGPT)에 그대로 실어 보냈다. 규칙이 잡은 건 *세션 모델*이지 *마커 모델*이 아니다.

**5. 수동 캐시는 트래픽 없으면 영원히 낡는다.** 한도가 응답 헤더로만 왔다. 조용한 날 11시간 동안 1%
(실제 39%)였고, 프차리플은 그래서 proxenos를 계속 살려 두고 있었다. 죽이려면 대체부터.

**6. 워커 진행은 `git status`로 본다.** 뮤즈 둘이 40분간 "조사 중"이었는데 diff가 0줄이었다. 알림
문구가 아니라 파일 변화가 진행의 증거다. 30분 내 코드 없으면 끊는다.

---

## ▶ 2026-09-20 — 오늘 커밋

| 커밋 | 내용 |
|---|---|
| `2071bde` | docs: 프로젝트 CLAUDE.md — 파이썬 프로토타입 보호 문장 삭제, 라이브 라우터 규칙 |
| `441cb3d` | feat: 체크한 모델 = 워커(에이전트 파일 생성·별칭 파생) + 라우팅 불능 명시 거부 + 한도 능동 조회 |
| `60028ba` | fix: 마커는 맨 앞만, 마커 모델은 자기 프로바이더로 |
| (다음) | docs: README 서브에이전트 절, 인수인계 |

테스트 268개 전부 통과. 신규: `agents.test.ts`(8), `proxy-refuse.test.ts`(4), routing/admin/chatgpt 추가.

---

## ▶ 2026-09-20 — 다음에 할 일

**1. 생성 에이전트가 12개라 목록이 길다.** `qwen`·`minimax`·`union-alpha`처럼 안 쓰는 모델은
주군이 GUI에서 체크를 빼면 파일도 빠진다. 세션이 config를 고치지 않는다.

**2. 남은 GitHub:** 이슈 #7은 신고자의 현행 버전 재현 대기라 상태 댓글을 남기고 열어 뒀다. #8(Claude
다계정)은 OAuth 그랜트 여러 개 저장·계정 라벨·대화 고정·갱신·쿼터/failover 정책이 필요한 유효 기능
요청이라고 답하고 열어 뒀다. #9·#10과 PR #11·#12는 완료·종료됐다.

**3. 무자격증명 검색 백엔드는 미완료.** 신뢰성과 이용 조건을 모두 만족하는 키 없는 일반 검색 원천을
찾지 못했다. 공개 SearXNG를 몰래 기본값으로 삼거나 DuckDuckGo HTML을 스크래핑하지 않는다.

**4. 릴리스.** 오늘 셋(`441cb3d`·`60028ba`·docs)은 사용자 눈에 보이는 동작 변화다(에이전트 파일이
`~/.claude/agents/`에 생긴다). `docs/RELEASE.md` 절차로 0.2.x를 내보내기 전에 README 문구가 실제
파일명과 맞는지 한 번 더 본다.

---

## ▶ 2026-09-19 — 먼저 읽을 것 (지난 것)

**1. 라이브 라우터는 오늘 코드가 전부 반영돼 있다.** 09:32:52에 처음 드레인 재시작하고, 스키마 수정·
자동 라우팅·GUI 수정 뒤로 세 번 더 재시작했다(마지막 11:0x). 어제 웹검색 가드(`1f4202e`)도 함께 올라갔다.
인플라이트 유실 없음. 대시보드에 서빙되는 `app.js`도 새 코드인 것을 8792 포트에서 확인했다.

**1-1. 주군 `config.json`의 direct 규칙 16개는 아직 남아 있다 — 일부러 그랬다.** 자동 라우팅이
덮으므로 무해하지만, 지우는 건 **주군이 GUI에서 아무거나 한 번 저장할 때** 자동으로 일어난다
(18개 → 2개). 세션이 남의 설정 파일을 직접 고치지 않는다. 저장 후에도 라우팅은 하나도 안 바뀌는 것을
시뮬레이션으로 확인해 뒀다.

**2. 어제의 "다음에 할 일 2번"(smallFast 캐시 0%)은 끝났다.** 전선에서 **97.6%** 측정했다.
아래 커밋 `752fa57`.

**3. 뮤즈가 다시 쓸 수 있다.** Artifact 툴이 붙은 세션에서 OpenCode Go가 400으로 전부 죽던 것을
고쳤다(`9053e7f`). 원인은 정규식 `\0` 하나였다.

**4. GPT 쿼터는 여전히 100%다** (오늘 18:19 리셋). 위임은 뮤즈로 간다 — 주군 지시로
`~/.claude/CLAUDE.md`의 워커 우선순위가 **뮤즈 1순위**로 바뀌었다(토큰당 비용이 가장 싸다).
**페이블은 서브에이전트로 쓰지 않는다.**

---

## ▶ 2026-09-19 — 오늘 밟은 함정 (전부 실측)

**1. 재현이 안 되면 내 프로브부터 의심해라.** 뮤즈 400의 범인을 찾으려고 스키마 조각을 던졌는데
네 케이스가 **전부 통과**로 나왔다. 프로바이더가 관대한 게 아니라, 내가 패턴 문자열을 잘못 인코딩한
것이었다. 원문 `^[^\0]*$`는 **역슬래시+'0' 두 글자**인데 Python에서 `"^[^\\u0000]*$"`로 써서 전혀 다른
문자열을 보내고 있었다. 정확히 맞춰 다시 던지니 1번에서 바로 400이 났다. **"재현 안 됨"은 결론이
아니라 내 도구를 의심할 신호다.**

**2. 신고자의 수정안을 코드로 확인하기 전에는 받지 마라.** 이슈 #7이 권한 "씨앗에서 `U+FFFD`만
지운다"는 한 줄은 **작동하지 않는다.** 깨진 쪽은 세 글자가 사라지는데 멀쩡한 쪽에는 원래 글자가
그대로 남아 두 해시가 여전히 다르다. 돌려보고 알았다. 대안으로 비ASCII를 전부 지우면 키는 붙지만
**서로 다른 한국어 첫 메시지가 한 키로 충돌한다** — 주군 사용자층에선 문제보다 나쁘다.

**3. 토큰 "개수"로 모델을 비교하지 마라.** 벤치마크 토큰 수만 보고 "뮤즈가 비싸다"고 했다가
주군께 정정받았다. **단가가 다르면 개수 비교는 의미가 없다.** 지금은 뮤즈가 토큰당 가장 싸다.

**4. metadata 없는 요청을 전부 한 키로 묶으면 ingress 대화가 뭉친다.** 캐시 키를 고칠 때
"metadata 없으면 시스템 프롬프트로" 로 끝냈으면 사고였다. **우리 OpenAI ingress는 metadata를
아예 만들지 않는다**(`packages/router/src/ingress/`에 한 글자도 없다). Codex CLI로 들어오는 진짜
여러 턴 대화가 전부 한 키·한 자격증명으로 끌려갈 뻔했다. 그래서 조건을 **`메시지 1개`**까지 걸었다.

**5. "`models`에 있으면 거기로 보낸다"를 곧이곧대로 짜면 클로드가 통째로 끌려간다.** 자동 라우팅의
가장 자연스러운 구현이 가장 위험하다 — 네이티브 `anthropic` 프로바이더가 `claude-opus-5`·
`claude-sonnet-5`·`claude-haiku-4-5`·`claude-fable-5-1`을 `models`에 들고 있기 때문이다. 그대로 짰으면
**세션의 모든 클로드 요청이 ingress 전용 프로바이더로 가서 전부 400**이 났다(ARCHITECTURE §5에 이미
있는 실패다). ingress 전용은 목적지에서 빼되 **소유자로는 세도록** 했다 — 건너뛰면 제3자가
`claude-opus-5`를 들고 나타났을 때 클로드 트래픽이 조용히 그리로 샌다.

**6. GUI가 규칙을 안 쓰게만 바꾸면 모호한 모델이 죽는다.** GUI는 저장할 때 체크박스에서 목록을
**다시 만든다.** 규칙 생성만 껐으면 다음 저장에서 `deepseek-v4-pro`의 규칙이 지워졌을 것이고, 그건
두 프로바이더가 같이 들고 있어 라우터가 일부러 추측을 거부하는 모델이라 **아예 안 가게 된다.**
피커 목록에도 없어서 다시 쓰이지도 않는다. "두 곳 이상이 들고 있는 id의 규칙은 체크가 안 돼 있어도
지킨다"를 넣어 막았다. **자동화를 넣을 땐 그 자동화가 무엇을 지우는지부터 봐라.**

---

## ▶ 2026-09-19 — 오늘 커밋

- **`752fa57`** — 대화가 아닌 요청은 **변하지 않는 것**(시스템 프롬프트)으로 키를 만든다.
  옆길 요청·제목·요약은 metadata가 없고 사용자 메시지가 매번 달라 요청마다 키가 새로 생겼다.
  라이브 라우터·`opencode-go-chat` 실측: 고정 프리픽스 7,210토큰, 사용자 메시지는 매번 다르게 3회 —
  캐시 읽기 **0 / 7,040 / 7,040 = 97.6%**. 대조군(키가 매번 바뀌는 옛 동작)은 3회 전부 **0**.
- **`9053e7f`** — 툴 스키마 패턴에서 `\0`도 떨어뜨린다. 9/13에 Codex용으로 넣은 스크럽이
  `\\[1-9]`(역참조)로만 적혀 있어 `\0`이 빠져나갔다. `\\[0-9]`로 부류를 넓혔다.
- **`ce71e22`** — **모델 자동 라우팅.** 규칙이 아무것도 안 걸리면, 그 id를 `models`에 가진
  프로바이더가 **정확히 하나일 때** 거기로 보낸다. 규칙이 여전히 우선이라 **빈칸만 메운다.**
  주군 실제 config로 모델 30개를 옛 `resolve()`·새 `resolve()`에 동시에 넣어 전수 대조:
  **이미 라우팅되던 것 중 달라진 것 0개**, 체크는 해뒀지만 앤트로픽으로 새던 3개
  (`deepseek-flash`·`moonshotai/kimi-k3`·`z-ai/glm-5.3-flash`)가 제 프로바이더로 붙었다.
- **`494e04a`** — **GUI가 모델마다 direct 규칙을 쓰던 것을 멈춘다.** 체크는 이제 "피커에 보이기"만
  뜻한다. 규칙은 **두 곳 이상이 들고 있는 id**에만 쓰고, 그런 id의 기존 규칙은 체크가 없어도 지킨다
  (위 함정 6). 피커 노출 범위는 주군 결정으로 **지금 그대로**(체크한 것만) 두었다.

---

## ▶ 2026-09-19 — 새로 확인된 사실 (전부 실측)

**캐시 키**
- `conversationKey`는 `prompt_cache_key`만이 아니다. **openai-compatible의 세션 헤더**
  (`providers/openai/index.ts:117`)이자 **자격증명 고정 키**(`proxy.ts:581`, `proxy.ts:595`)다.
  이 함수를 건드리는 변경은 캐시·세션·자격증명 셋을 동시에 건드린다.
- 이슈 #7(U+FFFD 손상)은 **metadata가 있는 쪽 가지**라 오늘 변경과 무관하다. 그 가지는 한 글자도
  안 바뀌었다. 답변을 달았고 **닫지 않았다** — 독립 재현이 없다(신고자 본인이 20회 시도해 0건).

**라우팅 (해석 순서가 바뀌었다)**
- 이제 `direct 규칙 → 슬롯(routes) → 선언한 프로바이더가 하나뿐인 모델 → 패스스루` 순이다.
  ARCHITECTURE §1 순서도와 §4 "Declared models route themselves"에 근거를 넣었다.
- **접두사 규칙은 여전히 쓸모가 있다.** 아직 아무 프로바이더도 선언 안 한 신모델을 잡는다
  (`gpt-`가 오늘 나온 모델을 받는다). 테스트로 못 박았으니 "이제 규칙 다 필요없다"고 지우지 마라.
- 자동으로 간 모델은 **per-model 컨텍스트 창을 안 갖는다** — `cli.extraModels`나 슬롯에 있어야
  갖는다. direct 규칙으로 가던 모델과 같은 조건이라 회귀는 아니지만, 창이 중요한 모델은 피커에 넣어라.
- 실전 확인(재시작 후): `DEEPSEEK deepseek-flash->deepseek-flash` 200, `OPENROUTER z-ai/glm-5.3-flash`
  200, 기존 규칙 2건 그대로, `PASS claude-haiku-4-5-20251001` — 클로드는 앤트로픽 직행이고 401은
  **앤트로픽이** 가짜 키를 거절한 것이다(`request_id` 있음). 가로채였다면 우리 400이 났을 것이다.

**툴 스키마 (OpenCode Go)**
- 거부하는 건 **`\0` 하나뿐**이다. 같은 스키마에서 패턴만 빼면 통과하고, `maxLength`·`minLength`는
  죄가 없다. `\d`·`propertyNames`·중첩 `anyOf`·`additionalProperties`·`const`·`format`·`$schema`·
  `exclusiveMinimum` **전부 통과**. 한 번에 쓸어 확인했으니 다음에 같은 걸 또 파지 마라.

**앤트로픽 1P 게이트웨이 (CLI 2.1.272 바이너리에서 확인)**
- `claude gateway`는 실재하는 서브커맨드다. "Run the enterprise auth/telemetry gateway", YAML 설정,
  Postgres(마이그레이션·`spend`·감사·신원 보존기간).
- 설정에 **`upstreams:`**(이름·`provider`·헤더)와 **`models:`**(모델 `id` → `upstream_model` 매핑),
  `pricing.overrides`, `timeouts.upstream_ttfb_ms`, `auto_include_builtin_models`가 있다.
  **모델→업스트림 라우팅 테이블이 실제로 있다.**
- 다만 코드에 나타난 `provider` 값은 `anthropic`·`vertex`이고 옆에 `bedrock`·`foundry`가 묶여 다닌다.
  모델 카탈로그도 전부 클로드다. 즉 **"같은 클로드를 어느 채널로 사느냐"를 고르는 것이지 멀티벤더
  라우터가 아니다.** 우리가 파는 건 후자이므로 §7 포지션은 오늘 기준 유지된다.
- **그러나 배관은 이미 깔려 있다.** provider 목록에 한 줄 더하면 되는 상태라, 우리 해자는 기술이
  아니라 **유인**(앤트로픽이 자기 앱에서 경쟁 모델을 팔 이유가 없다)이다.
- **확인 못 한 것:** `provider` 허용값 전체 목록. 게이트웨이 YAML 스키마 문서를 못 찾았다.
  확정하려면 실제 설정으로 검증 오류를 받아봐야 한다.

**Claude Code 2.1.272 릴리스노트 중 우리에게 걸리는 것**
- **캐시 관련 수정 3건**: `/clear` 이후 첫 메시지 누락, 재개된 서브에이전트의 MCP 툴 정의 재렌더,
  첨부 재렌더. 전부 **턴 사이에 요청 바이트가 달라지던** 문제라, 우리 번역기의 "다음 턴 입력은
  이번 턴의 바이트 접두사" 규칙을 CLI 쪽에서 깨고 있었다. **앞으로 인수 기준을 잴 땐 CLI 버전을
  같이 기록하라.** (오늘 측정은 curl로 CLI를 건너뛰었으니 영향 없다.)
- `TaskOutput` 툴 제거 — 저장소 참조 **0건**, 할 일 없음.
- AGENTS.md 지원 — README가 "CLAUDE.md도 그대로 돕니다"라고 쓴 세 곳에 한 단어 더할 여지. 급하지 않다.
- **U+FFFD 손상은 고쳐지지 않았다.** `anthropics/claude-code#93848`은 여전히 열려 있다.

**환경 (제품과 무관하지만 다음 세션이 헷갈릴 것)**
- 메뉴바에 뜨던 정체불명 16진수 세션들은 **제2의 두뇌 증류 파이프라인**이 띄운 헤드리스
  `claude -p`다(`~/.claude/projects/-Users-pbj--claude-obsidian-sync/`). 세션 하나를 4만 자씩 잘라
  구간마다 하나씩 띄우므로 한 번에 10개씩 생긴다. `ai-status.15s.py`에서 제외했다.
- **페이블 상속 구멍:** `Explore`·`Plan`·`claude`·`general-purpose`는 모델이 `inherit`이라 세션 모델을
  따라간다. 세션이 페이블이면 그것들이 페이블로 돈다. `CLAUDE_CODE_SUBAGENT_MODEL`도
  ClaudeRipple `cli.models`도 미설정이라 막는 것이 없다. CLAUDE.md에 명시해뒀다.

---

## ▶ 2026-09-19 — 다음에 할 일

> **어제 1번(모델 자동 라우팅)과 2번(smallFast 캐시)은 끝났다.** 아래는 남은 것이다.

**1. 이슈 #7 (재현 대기).** 코드는 안 고쳤다. 고친다면 정규화가 아니라 **키 고정**이다 — 깨끗한
씨앗을 기억해두고 나중 씨앗이 `U+FFFD` 덩어리만 다르면 기억한 **키**를 재사용한다. 본문은 그대로
흘려보내므로 바이트 전달 원칙이 산다. 독립 재현이 나오기 전에는 하지 마라.

**2. ChatGPT 웹검색 백엔드 (쿼터 대기).** 어제 3번 그대로.

**3. 무자격증명 검색 백엔드.** 어제 4번 그대로.

**4. `docs/OPENCODEX.md` §7에 `claude gateway` 한 줄.** 위 "새로 확인된 사실"의 요지를 옮기면 된다.

---

## ▶ 2026-09-18 — 먼저 읽을 것 (지난 것 — 1·2번은 9/19에 해소됐다)

**1. 라이브 라우터에 오늘 커밋이 반영돼 있지 않다.** 프로세스는 `06:20:58Z`에 떴고 오늘 코드는 그 뒤에
썼다. 웹검색 가드(`1f4202e`)가 실제로 돌게 하려면 재시작해야 한다:
`cd /Users/pbj/Documents/ClaudeRipple && node packages/cli/src/index.ts restart`

**2. 주군 세션 중 일부에 오염된 환경변수가 남아 있을 수 있다.** 오늘 `~/.claude/settings.json`에
`ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4.1-flash`를 넣었다가 되돌렸는데, **파일을 되돌려도 이미 떠 있는
세션의 프로세스 환경에는 값이 남는다.** 그 세션의 웹검색은 계속 OpenCode Go DeepSeek으로 가고, 거기선
검색이 아예 실행되지 않는다(아래 함정 1). 증상은 "웹서치 도구가 응답하지 않습니다". **해당 세션을 새로
열면 끝난다.** 디스크는 이미 순정이다.

**3. GPT 쿼터는 여전히 소진 상태다.** `ChatGPT: The usage limit has been reached`. 그래서 ChatGPT
웹검색 백엔드를 검증하지 못했고, 검증 못 한 채로 붙이지 않았다(아래 남은 일 3번).

---

## ▶ 2026-09-18 — 오늘 밟은 함정 (전부 실측)

**1. 같은 DeepSeek이라도 경로가 다르면 서버툴을 못 돌린다.** `api.deepseek.com/anthropic`은
`web_search_20250305`를 받아 실제로 검색하고 결과 10건을 정상 블록으로 돌려준다. **같은 모델을 OpenCode
Go로 부르면 못 한다.** openai 어댑터가 서버툴과 `tool_choice`를 드롭하므로(translate.ts:87,96) 모델에게는
"너는 웹검색 도구를 수행하는 어시스턴트다 / 이 질의로 웹검색을 수행하라"만 남고 **도구가 하나도 없다.**
모델은 시키는 대로 하려고 자기 마크업으로 도구 호출을 지어낸다 —
`<｜｜DSML｜｜ invoke name="web_search">…`가 평문 text 블록으로, 검색 0건, **HTTP 200**.
→ 모델 이름으로 능력을 추정하지 마라. `serverTools`는 프로바이더별 실측값이다(compat.ts).

**2. 설정 파일을 되돌려도 살아있는 세션은 안 돌아온다.** env는 프로세스에 박힌다. 그래서 검증을
"파일이 원복됐다"로 끝내면 안 되고, **새 셸에서** 확인해야 한다. 오늘 이걸 놓쳐서 원복 뒤에도 검색이
DeepSeek으로 가는 걸 보고 한참 헤맸다.

**3. 첫 번째 가드는 조용히 작동하지 않았다.** 옆길 요청인지 **판별하는 것 자체**가
`cfg.webSearch`가 설정됐을 때만 돌게 짜여 있었다(옛 proxy.ts:427). 가드가 가장 필요한 상태 —
백엔드 미설정 — 에서는 검색인 줄도 몰랐다. **판별과 처리를 묶지 마라.** 재현 테스트로 잡았다.

**4. 요금 모델을 두 번 틀렸다.** 공개 요금 페이지(종량제)를 보고 "1,000번에 6센트"라고 계산했는데,
주군은 **OpenCode Go 구독 한도제**를 쓴다. 그리고 그 한도는 요청 횟수가 아니라 **토큰 비용으로 $60을
깎는다**("예상 요청 횟수"가 그 증거). 값을 논할 땐 어느 과금 모델인지부터 확정하라.

**5. 검증했다고 말하기 전에 무엇을 검증했는지 보라.** smallFast를 DeepSeek으로 바꾸고 "됐습니다"라고
보고했는데, 확인한 건 **요청이 거기로 갔다**는 것뿐이고 **검색이 됐다**는 건 확인한 적이 없었다.
`claude -p` 출력이 `파싱 실패`로 찍혔는데 그걸 넘겼다. 라우팅 로그는 도착지만 말한다.

---

## ▶ 2026-09-18 — 오늘 커밋

- **`3a1e90b`** — 웹검색 백엔드를 프로바이더 종류로 분기. `anthropic-compatible`이면 Anthropic 모양
  그대로 서버툴을 물려 보내고 `web_search_tool_result`를 읽어낸다(`anthropicServerToolBackend`).
  별도 포트(8795) 격리 라우터에서 실측: `web search via deepseek`, 결과 10건, 3.2초.
- **`99e0482`** — README 영/한에 서브에이전트 두 갈래를 명시. `HANDOFF` TODO 7번을 닫았다.
- **`1f4202e`** — 서버툴 못 돌리는 곳으로 갈 옆길 요청은 **보내지 않고 거부**한다.
  `web_search_tool_result_error: unavailable`, `web_search_requests: 0`.

---

## ▶ 2026-09-18 — 새로 확인된 사실 (전부 실측)

**웹검색 경로**
- `api.deepseek.com/anthropic` → 서버툴 실행 **O** (결과 10건, `web_search_requests: 1`).
- OpenCode Go 경유 DeepSeek → **X** (위 함정 1).
- OpenRouter → **X**. `Server tool "openrouter:web_search" failed: invalid request (400)`.
- **하이쿠가 순정 기본이다.** 본 모델이 Sonnet인 세션에서도 검색은 `claude-haiku-4-5`가 했다.
  Opus·DeepSeek 라우팅 세션에 이어 세 번째 확인. `ANTHROPIC_SMALL_FAST_MODEL`을 안 건드리면
  본 모델이 무엇이든 하이쿠다. 이건 Claude Code 동작이지 ClaudeRipple과 무관하다.
- **옆길 요청에는 `metadata`가 없다.** user_id도 세션 id도 없다(websearch.test.ts 픽스처).
  그래서 "세션마다 자기 모델이 검색한다"는 **지금 구조로는 구현 불가**다. 라우터가 그 검색이 어느
  세션 것인지 알 방법이 없다. opencodex도 같은 결론이라 백엔드를 하나 고정한다.

**서브에이전트**
- **에이전트 파일은 필수가 아니다.** `cli.models.subagent`만 잡으면 모든 서브에이전트가 그 모델로
  돈다. 격리 라우터 실측: 본 턴 `claude-opus-5`, 서브에이전트 `deepseek-v4.1-flash`, 에이전트 파일 없음.
- **이름을 붙여 부르려면**(`subagent_type: "muse"`) 파일이 필요하다. 이름이 없으면 하네스가 못 찾는다.
  주군이 뮤즈를 못 쓰셨던 게 이 경우다. 두 갈래는 서로 다른 얘기이므로 섞어 답하지 마라.

**opencodex / OpenClaude (코드까지 읽고 확인)**
- opencodex의 웹검색 sidecar: 호스티드 툴을 떼고 합성 function tool `web_search(query)`로 바꿔 끼운 뒤
  **최대 3회**(`maxSearchesPerTurn`) 루프. 예산 소진 시 합성 툴을 빼고 강제 최종답변.
  결과는 평범한 `tool_result` 텍스트(답변 4000자·소스 8개 상한)로 돌려주고, 아웃바운드가
  `server_tool_use` + `web_search_tool_result`로 번역한다.
- 백엔드는 `openai`(ChatGPT forward, 기본)·`anthropic`·`xai`·`gemini`·`exa` **다섯뿐**.
  Brave·Tavily·SearXNG는 **없다.** 자격증명 없으면 fail-closed(사이드카 자체를 안 켬).
- **루프는 우리에겐 불필요하다.** 그쪽 백엔드가 Anthropic 서버툴을 직접 못 받기 때문에 있는 것이다.
  서버툴을 직접 돌리는 프로바이더는 번역도 루프도 필요 없다.
- **opencodex도 "각 모델이 자기 검색을 한다"를 하지 않는다.** 라우티드 모델은 전부 사이드카 하나로 간다.
- OpenClaude는 프록시가 아니라 터미널 코딩 에이전트 CLI다. 비교 대상이 아니지만 **무자격증명 기본
  백엔드(DuckDuckGo)** 하나는 우리에게 없는 아이디어다.

**모델 벤치마크 (2문제, 487개 검사)**
- 1번 `parseDuration`(사양 준수): **다섯 모델 전부 만점**(27/27 + 까다로운 35/35 + 비문자열 10/10).
- 2번 `diff` 최소 편집 스크립트(LCS 필요): Opus 5·DeepSeek Flash·Muse·GLM-5.3 통과(무작위 400건도
  전부 400/400). **Qwen3.8 Max는 3전 3패**(500 1회, 업스트림 포기 2회).
- 정확도로는 안 갈린다. 갈리는 건 값이다 — 총합 DeepSeek Flash 11,914토큰/49초, Opus 5
  10,898/131초, Muse 17,810/147초, GLM-5.3 43,822/550초. GLM은 2번에서 Opus와 **거의 같은 코드**를
  내놓고 토큰 4.9배·시간 5.5배를 썼다.
- **Qwen3.8 Max는 위임하지 마라.** 틀리는 게 아니라 끝을 못 맺는다. 같은 프롬프트에 한 번은 16,000
  토큰 태우고 본문을 못 냈고, 한 번은 9,161에 정상 종료했다.

**규칙 변경 (주군 지시)**
- **참조 구현의 코드를 읽어도 된다.** `docs/OPENCODEX.md`에 있던 "읽지도 마라"는 내가 혼자 덧붙인
  과잉이었고 지웠다. **복사는 여전히 금지**(CLAUDE.md, 주군이 "규칙유지로"로 재확정). 읽고 이해해서
  우리 걸 쓴다.

---

## ▶ 2026-09-18 — 다음에 할 일

**1. 모델 자동 라우팅 (주군이 하겠다고 하심, 지금은 아님).**
지금 `resolve()`는 `cfg.direct`의 접두사 규칙과 `cfg.routes`만 본다(routing.ts:65-77).
**프로바이더가 그 모델을 `models` 목록에 갖고 있다는 사실은 라우팅에 전혀 안 쓰인다.** 그래서 GUI에서
모델을 체크해 저장해도 direct 규칙을 손으로 넣어야 쓸 수 있고, 주군 config에 규칙이 18개 쌓인 이유가
그것이다. 파세오와 갈리는 지점이 정확히 여기다.
- 설계: **어떤 모델 id를 `models`에 가진 프로바이더가 정확히 하나면 거기로 보낸다.** 둘 이상이 같은
  id를 들고 있으면 모호하므로 지금처럼 명시 규칙을 요구한다. direct 규칙은 "기본과 다르게 보낼 때"만
  쓰는 예외 장치로 돌아간다. 피커 노출(`cli.extraModels`)도 같이 자동화 가능.
- 주의: **라우팅 기본 동작을 바꾸는 변경**이라 주군 상시 환경에 바로 영향이 간다.
- 참고: 자동 조회 자체는 **이미 된다.** 프로브가 `/models`를 부르고 GUI가 전부 체크리스트로 보여준다.
  12개를 넘으면 자동 체크를 안 할 뿐이다(app.js:1203).

**2. smallFast 경로의 프롬프트 캐시가 0%다 (진단 완료, 미수정).**
로그 실측: `deepseek-v4.1-flash` **68건 전부 캐시 0**. 같은 로그에서 Muse 129건 중 97건,
Opus 11,633건 중 6,960건은 히트한다.
- **엔드포인트 문제가 아니다.** 같은 세션 헤더로 chat wire에 두 번 던지면 2회차에
  `prompt_tokens_details.cached_tokens: 2304 / 2441` = **94%**가 나온다. 어댑터가 읽는 필드도 맞다.
- **원인은 우리 세션 키다.** `conversationKey`는 `metadata.user_id` + **첫 사용자 메시지**의
  해시다(translate.ts:92-96). 옆길·일회성 요청은 metadata가 없고 첫 메시지가 매번 다르므로
  **요청마다 세션이 새로 생기고** 캐시가 영원히 차갑다.
- 설계 방향: `metadata.user_id`가 없는 요청은 변하는 사용자 메시지로 키를 만들지 말고 **불변인
  시스템 프롬프트**에서 뽑아라. 그러면 같은 종류의 옆길 요청이 한 세션을 공유하고 고정 접두사가 캐시된다.
- **CLAUDE.md의 인수 기준(번역 프로바이더 캐시 히트 ≥90%) 위반이므로 우선순위가 낮지 않다.**

**3. ChatGPT 웹검색 백엔드 (쿼터 대기).**
GPT만 구독한 사용자를 받으려면 필요하다. opencodex의 기본 백엔드가 이것이라 될 가능성이 높지만
**쿼터가 막혀 검증하지 못했고, 검증 없이 붙이지 않았다.** 쿼터가 풀리면 옆길 요청 모양 그대로
`gpt-5.6-terra`에 던져 `server_tool_use`가 돌아오는지부터 확인하라. 문서 보고 짜놓고 "된다"고 하는 건
오늘 이미 한 번 밟았다.

**4. 무자격증명 검색 백엔드.**
우리도 opencodex도 백엔드가 전부 "이미 누군가에게 돈을 내고 있다"를 전제한다. 클로드도 GPT도 구독하지
않은 사용자는 검색이 아예 안 된다. OpenClaude가 DuckDuckGo로 메운 자리다.

---

## ▶ 2026-09-17 — 먼저 읽을 것 (지금 이 컴퓨터의 상태)

**1. 데일리 드라이버가 작업 트리로 바뀌었다.** 라우터는 이제
`/Users/pbj/Documents/ClaudeRipple/packages/router/src/index.ts` 에서 돈다. `/Applications/ClaudeRipple.app`
이 아니다. 주군 승인 아래 `install`을 체크아웃에서 돌려 launchd plist를 교체했다(같은 파일을 덮어쓰므로
supervisor가 둘로 늘지 않는다). 설치본은 0.1.2였고 저장소는 0.2.0이라 두 단계 뒤처져 있었다.

- **트레이 앱(`ClaudeRipple.app`)을 열면 되돌아간다.** 앱은 실행될 때 `/api/status.runtime`으로 "설치된 게
  나인가"를 확인하고, 아니면 자기 것으로 다시 깐다. 라우터 조작은 터미널에서 한다:
  `cd /Users/pbj/Documents/ClaudeRipple && node packages/cli/src/index.ts restart`
- 코드를 고치면 **재시작만** 하면 반영된다. 빌드 불필요.

**2. 이 문서를 쓰는 시점에 라이브 라우터는 오늘 작업이 반영되지 않은 상태다.** 커밋은 전부 main에 올라가
있지만 프로세스가 재시작되지 않았다. 반영하려면 위 `restart`.

**3. GPT 쿼터가 소진됐다.** 9/17 오후 기준 `사용량 100%`, 약 49시간 뒤 리셋. 그래서 `gpt`/`gpt-smart`
서브에이전트는 **전부 429로 죽는다.** 위임할 일이 있으면 클로드 서브에이전트를 쓰되, **브리핑에
"서브에이전트를 만들지 마라"를 명시해야 한다** — 안 쓰면 그 에이전트가 CLAUDE.md 규칙대로 다시 gpt를
풀어서 전멸한다(오늘 실제로 넷 잃었다).

---

## ▶ 2026-09-17 — 오늘 밟은 함정 (전부 실측)

다음 사람이 같은 곳에 빠지지 않도록. 근거는 ARCHITECTURE의 해당 절에 있다.

**웹서치는 본 요청에 없다.** Claude Code는 `WebSearch`를 **별도 side request**로 띄운다. 시스템 프롬프트
한 줄("You are an assistant for performing a web search tool use"), 메시지 한 줄
("Perform a web search for the query: …"), 서버 툴 하나. 그 요청이 가는 모델은 `ANTHROPIC_SMALL_FAST_MODEL`
이고, 안 건드리면 **하이쿠로 가서 Claude 한도를 먹는다.** 오푸스 세션이든 딥시크 세션이든 똑같다(둘 다
`claude-haiku-4-5`, 입력 11,208 토큰으로 동일하게 측정됐다).

**소스와 전선이 다르다.** CLI 바이너리는 그 side request에 `toolChoice: {type:"tool"}`을 넘기는데,
**실제로 나가는 건 `{"type":"auto"}`** 다. 소스만 믿고 조건을 걸면 아무것도 안 걸린다. 지문은
"선언된 툴 하나 + CLI 고정 문장 하나"로 잡아야 한다.

**딥시크는 웹서치를 서버사이드로 직접 실행한다.** 문서에 한 줄도 없다. API에 `web_search_20250305`를
보내면 `server_tool_use` + `web_search_tool_result`(10건) + `usage.server_tool_use.web_search_requests: 1`이
온다. **문서를 보고 "없다"고 두 번 단정했다가 API에 물어보고 뒤집혔다.** 벤더 능력은 문서가 아니라 API에
물어라. 지금은 `caps.serverTools`로 프리셋별로 구분한다.

**`upReq.destroy()`는 ECONNRESET 에러 이벤트를 낸다**(Node 24.15 실측). 프로바이더가 끊은 것과 구분이
안 되므로, 우리가 죽였다는 플래그가 없으면 **사용자가 ESC를 누를 때마다** 자격증명이 벌점을 먹는다.

**Node의 `fetch`는 `HTTPS_PROXY`를 안 본다.** 테스트가 프록시를 안 거치고 실제 Anthropic으로 직행해서
401을 받는다. 프록시 경유 테스트는 `curl --proxy --cacert` 또는 `claude -p`로 해라.

**`pkill -f "packages/router/src/index.ts"`는 설치본 라우터도 잡는다.** 앱이 자기 리소스 안의 같은 경로를
실행하기 때문이다. 오늘 두 번 죽였다(드레인은 정상 동작했고 launchd가 0.5초 만에 되살렸다). **PID를
특정해서 죽여라.**

**내장 에이전트 중 둘은 모델이 박혀 있다.** `claude-code-guide`는 `model:"haiku"`,
`statusline-setup`은 `model:"sonnet"`. `Explore`·`Plan`은 `inherit`이라 세션 모델을 따른다(즉 문제없다).
슬롯으로도 못 덮는다. 자주 도는 게 아니라 **손대지 않기로 했다.**

---

## ▶ 2026-09-17 — 한 일

### 신고 이슈 3건 (전부 `115dkk`, 전부 코드 읽고 쓴 진짜 버그)

| 이슈 | 내용 |
|---|---|
| #1 | 툴 이름 64자 초과가 그대로 전달돼 요청 전체가 실패. MCP 이름은 일상적으로 넘는다 |
| #2 | `cli.autoCompactWindow` 하나가 모든 라우팅 모델에 강제 |
| #4 | 서버 툴이 일반 function으로 선언돼 실행 주체 없는 팬텀 툴이 됨 |

셋 다 **신고보다 범위가 넓었다.** #1은 openai-compatible에도 같은 코드가 있었고, #2는 주입 지점이
두 곳이 아니라 셋이었으며(`cli/settings.ts`), #4는 드롭이 정답이 아니라 **능력별 구분**이 정답이었다.

댓글로 답하고 PR #3·#5·#6으로 닫았다. #2 신고자의 근거 하나(`CLAUDE_CODE_MAX_CONTEXT_TOKENS`가 클로드
모델까지 망가뜨린다)는 ARCHITECTURE §5 실측과 반대라 댓글에서 정정했다.

### 웹검색이 Claude 한도를 안 먹게

목표: **"딥시크를 쓰는데 웹검색은 하이쿠가 하고 Claude 한도를 먹는다"** 를 없애기. 두 경로를 만들었다.

1. **네이티브 통과** — 프로바이더가 실행할 수 있으면 서버 툴을 떼지 않고 그대로 보낸다(딥시크).
   `ANTHROPIC_SMALL_FAST_MODEL`을 라우팅 모델로 돌리면 **세션 전체에 Anthropic 호출 0건**을 측정했다.
2. **가로채기(`cfg.webSearch`)** — 못 하는 프로바이더용 대역. 라우팅 전에 지문으로 잡아 프로바이더 자체
   호스티드 검색으로 답한다. 첫 백엔드는 OpenRouter(`plugins:[{id:"web"}]` → `annotations[].url_citation`).

**통과가 우선, 가로채기는 대역.** `usage.server_tool_use.web_search_requests`를 채워야 "Did N searches"가
0으로 안 찍힌다.

### 모델 슬롯 (`cli.models`)

`main`→`ANTHROPIC_MODEL`, `smallFast`→`ANTHROPIC_SMALL_FAST_MODEL`, `subagent`→`CLAUDE_CODE_SUBAGENT_MODEL`.
설치 때 `settings.json`에 쓰고, GUI 클라이언트 화면에 드롭다운으로 노출했다. 안 고른 슬롯은 건드리지
않고, 비우면 지우고, **언인스톨 시 셋 다 회수한다**(안 그러면 라우터가 사라진 뒤에도 그쪽을 가리킨다).

### 자격증명 풀 + 프로바이더 failover + 같은 턴 재시도

주군이 오늘 GPT 쿼터로 몇 시간 막힌 게 계기다. `pool.ts`가 핵심 상태 기계다.

- **고정(stickiness)은 최적화가 아니라 캐시다.** 대화가 자격증명을 옮기면 프롬프트 캐시가 식는다.
  대화 키는 `conversationKey`(= 캐시가 쓰는 것과 같은 것). `metadata.user_id` 원값을 쓰면 한 사용자의
  **모든 대화가 한 값을 공유**해서 동시에 끌려간다.
- **실패를 누구에게 청구하느냐**가 핵심. 401만 격리(403은 콘텐츠 정책·리전 차단일 수 있어 대기),
  429는 벤더가 말한 시각까지(6시간 상한), 402는 30분, 5xx·연결실패는 10초.
  **우리 요청이 틀린 4xx는 아무에게도 청구 안 한다** — 안 그러면 풀 전체를 태우고도 실패한다.
- **failover 선택은 보내기 전에** 한다. 첫 바이트가 나가면 그 턴은 확정이다(반쪽 답 두 개가 이어붙는다).
- **같은 턴 재시도**는 첫 바이트 전에만. 자격증명당 한 번, 풀이 바닥나면 멈춘다.

대시보드 상태 화면에 "어느 키가 쉬는 중이고 몇 초 뒤 복귀"가 뜬다. **id와 label만 내보낸다.**

### 독립 검수에서 나온 치명 3건 (전부 배선에 있었다)

단위 테스트를 다 통과했는데도 있었다. 이게 오늘 제일 중요한 교훈이다.

1. **풀이 chatgpt·openai-compatible 어댑터를 몰랐다.** 그 분기가 자격증명 기록 전에 return해서
   `hasUsable`이 영원히 참 → **주력 경로에 failover가 아예 없었다.**
2. **풀이 전부 쉬는 중이면 인증 헤더 없이 요청이 나갔다.** 돌아온 401이 멀쩡한 키를 영구 격리했다.
3. **취소할 때마다 자격증명이 벌점을 먹었다**(ECONNRESET 건).

그래서 `test/proxy-failover.test.ts`를 만들었다 — **상태 기계가 아니라 실제 프록시를 띄운다.**
세 개는 코드보다 먼저 쓰고 빨간불을 확인했고, 두 개는 고친 걸 다시 부숴서 빨간불을 확인했다.
**"테스트가 통과한다"와 "테스트가 결함을 잡는다"는 다르다** — 처음 쓴 취소 테스트는 가짜 업스트림이
너무 빨리 답해서 고치기 전에도 통과했다.

### UI 수정

- **피커 타일에서 모델 이름이 "GPT…", "De…"로 잘려 나갔다** — 내가 만든 회귀다. 컨텍스트 창 입력칸을
  한 줄에 욱여넣어 이름 자리를 뺏었다. 두 줄로 바꿨다. 입력칸이 `<label>` 안에 있어 클릭이 체크박스를
  토글하던 것도, `preventDefault`가 포커스까지 막던 것도 고쳤다(라벨 밖으로 뺐다).
- **제목이 본문보다 어두웠다.** `.card h2`/`h3`가 `--muted`인데 본문이 `--text`라 위계가 뒤집혀 있었다.
- **프로바이더 순서가 계속 바뀌었다.** 상태 화면은 `Promise.all` 콜백 안에서 키를 넣어 TCP 확인이 끝나는
  순서대로였고, 프로바이더 탭은 확인이 끝날 때마다 **카드를 지우고 맨 뒤에 붙이고** 있었다.
- 벤더 에러 JSON이 통째로 찍혀 배지를 뭉개던 것 → 한 줄로 줄이고 전문은 hover.
- 연결 확인 결과가 낡아도 영원히 빨간불이던 것 → **90초 TTL**. 그 뒤엔 5초 폴링이 넘겨받는다.
- 쿼터 줄에서 "49시간 뒤 초기화" 제거.

### opencodex 전량 대조 → `docs/OPENCODEX.md`

문서 43편을 읽어 기능 전량을 뽑고 우리와 대조했다. **코드는 한 줄도 안 봤고 앞으로도 안 본다**
(MIT라 복사는 합법이지만 주군이 규칙 유지로 결정했다). 어댑터 10종의 와이어 명세가 거기 있으니
프로바이더 추가할 때 43편을 다시 읽지 마라.

**목표가 정해졌다: opencodex 기능 전부 + Claude 1P.** 라우터는 하나만 쓸 수 있으니 부분집합이면 애초에
선택지가 안 된다. 판정 기준은 "키 300개를 다 구현했는가"가 아니라 **"지금 opencodex 쓰는 사람이
갈아타도 잃는 게 없는가"** 다.

---

## ▶ 2026-09-17 — 남은 일

**1군 (갈아탈 수 없게 만드는 것)**
- **ChatGPT 다중 계정** — 유일하게 못 끝낸 것. 헤더가 아니라 OAuth라 그랜트를 여러 개 저장하고
  로그인 흐름·선택 UI를 손봐야 한다. 프로바이더 단위 failover는 되므로 급한 불은 꺼졌다.
- **어댑터 확장** — `google`(AI Studio/Vertex/Antigravity), `azure-openai`, `ollama-native`.
  프리셋으로는 못 붙는 와이어다. 명세는 `docs/OPENCODEX.md` §3.
- **비전 사이드카** — 텍스트 전용 모델에 이미지가 오면 지금은 그냥 깨진다.
- **사용량·비용 추정** — 지금은 토큰만 기록한다.

**정리해야 할 것**
- README에 `webSearch`·`cli.models` 언급이 **0건**이다. 코드와 ARCHITECTURE와 GUI에만 있다.
- `admin.ts` 상단 주석이 엔드포인트를 7개만 적는다. 실제 21개.
- `ROADMAP.md`가 9/13에 멈춰 M4/M5를 "진행 중"으로 적는다. 둘 다 끝났다.
- `presets.ts`의 `zai`(Z.AI GLM)만 `verified: false` — 실제로 찔러본 적이 없다.
- Codex 호스티드 검색 백엔드 — GPT 쿼터가 돌아오면 붙이고 검증.

**판단이 필요한 것**
- 0.2.1 npm 배포 여부(오늘 작업이 상당하다).
- opencodex가 **Claude Desktop을 어떤 방식으로 잡는지** — 문서로 판별 불가. 게이트웨이 설정을 쓴다면
  커넥터를 잃을 것이고 그게 우리 해자다. 확인하려면 소스를 봐야 하는데 규칙에 걸린다.

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

**Windows 실측 완료 (2026-09-16 오후, 패러렐즈 Windows 11 arm64, build 26100).**

VM이 안 켜지던 것부터 잡아야 했다. `PRL_ERR_SECURE_BOOT_VIOLATION` — 부팅 이미지 서명 검사 실패로 2초 만에
CPU가 멈췄다. `prlctl start`는 프로세스 기동까지만 보고하므로 "성공"이라고 답한다. 주군 승인으로 Secure Boot를
껐다(`prlctl set "Windows 11" --efi-secure-boot off`, 원본 config 백업 `/tmp/config.pvs.bak-20260916T163644`).
검증은 `prlctl exec`로 게스트 안에서 돌렸고, 파일은 공유 폴더 `\\Mac\Home\cr-vm-test`로 넘겼다.

**install.ps1에서 잡은 버그 셋 (전부 Windows에서만 드러난다).**
1. **Node가 있는데도 없다고 판단.** `node -e '...split(".")...'`의 따옴표를 PowerShell 5.1이 망가뜨려
   SyntaxError가 stderr로 나가고, `ErrorActionPreference=Stop` 때문에 그게 종료 오류가 된다. → `node -v` +
   정규식으로 바꿨다. 이게 주군이 말한 "Node 있으면 건너뛰기"를 실제로 지키는 부분이다.
2. **`Move-Item`이 없는 상위 폴더를 만들지 않는다.** 30MB를 다 받아 놓고 "경로의 일부를 찾을 수 없습니다"로
   죽었다. → 옮기기 전에 상위 폴더를 만든다.
3. **npm이 만든 `clauderipple.cmd`가 맨 `node`를 호출한다.** 우리가 받은 Node가 그 PC의 유일한 Node면
   PATH에 없어서 명령이 시작조차 못 한다(설치는 성공 보고). macOS 셔뱅 문제와 똑같은 함정의 Windows판.
   → 우리가 Node를 받은 경우 `.cmd`와 `.ps1`을 그 Node를 직접 가리키는 래퍼로 덮어쓴다.

**CLI에서 잡은 버그 하나.** `uninstall --purge`가 Windows에서 `EPERM`으로 실패했다. 작업 스케줄러 항목만 지우고
라우터 프로세스는 살려 두는데, 그 프로세스가 `router.log`를 붙잡고 있어 홈 디렉터리가 안 지워진다(launchd는
unload가 프로세스까지 데려가서 macOS에서는 안 드러난다). → `uninstall`이 먼저 `stopAgent()`를 부르고, 핸들
해제 경합을 대비해 짧게 재시도한다.

**통과한 항목 (Windows 11 arm64).** Node 숨긴 상태에서 다운로드→SHA256 대조→설치→명령 실행,
`npm install --global --prefix`가 명령을 prefix 루트에 두는 것 확인, 사용자 PATH 등록,
`clauderipple install --port 8890`(인증서·설정·작업 스케줄러·라우터·종단 프로브 전부 ✓),
대시보드 HTTP 200, `/api/status`가 npm 배치의 `dist\router\src\index.js`를 보고,
**`restart`가 실제로 프로세스를 교체**(startedAt 07:52:23 → 07:52:54 — 0.1.1에서 고장 나 있던 바로 그 기능),
Electron 없는 `tray`의 안내 문구, `uninstall --purge` 완전 제거. 시험 흔적(C:\cr-test, 사용자 PATH 항목,
작업 스케줄러, node 프로세스)은 모두 지웠다.

**x64도 같은 VM에서 확인했다.** 애플 실리콘에서는 패러렐즈가 x64 Windows를 못 돌리지만, Windows on ARM에
x64 에뮬레이션이 있어서 `PROCESSOR_ARCHITECTURE=AMD64`로 두고 돌리면 스크립트가 win-x64 빌드를 받는다.
받은 Node는 `process.arch=x64`로 답했고, 그 런타임으로 설치·대시보드 200·재시작(08:02:06 → 08:03:33)·
`uninstall --purge`까지 전부 통과했다. **남는 미검증은 "네이티브 x64 하드웨어에서 `PROCESSOR_ARCHITECTURE`가
실제로 AMD64로 오는지"** 하나뿐인데, 그건 switch 한 줄이고 에뮬레이션에서 그 값을 그대로 넣어 확인했다.

**검증 못 한 것.**
- `irm | iex` 경로 자체(스크립트 파일로 실행했다). GitHub raw에 올라간 뒤 실행 정책과 함께 한 번 볼 것.
- 네이티브 x64 하드웨어. 이 맥에서는 불가능하다(패러렐즈가 애플 실리콘에서 x64 게스트를 지원하지 않는다).
- npm에 **아직 게시하지 않았다.** 주군 승인 대기.

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
7. ~~README에 **GPT 서브에이전트 에이전트 파일 예시** 추가~~ — 2026-09-18 완료(README.md·README.ko.md의 Claude Code 절).
   답을 두 단계로 나눠 적었다: **에이전트 파일은 필수가 아니다**(`cli.models.subagent` 하나면 모든 서브에이전트가 라우팅된
   모델로 돈다 — 격리 라우터에서 실측), 파일은 **이름 붙은** 서브에이전트를 만들 때만 쓴다. 주군의 `gpt`/`gpt-smart`
   타입은 ClaudeRipple에 포함된 게 아니라 주군 개인 설정임.

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
