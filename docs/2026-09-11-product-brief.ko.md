# claude-router 제품화 브리프

> 2026-09-11 정리. 다른 세션(페이블)과 논의하기 위한 인계 문서다.
> 배경 기술 상세는 메모리 `claude-router-1p-app-gpt`에 있다 — 이 문서는 **제품·경쟁·전략**이다.

---

## 0. 한 줄

**Claude Desktop 앱을 끄지 않고, 그 안에서 GPT·기타 AI를 같이 쓰게 하는 로컬 프록시.**
경쟁자들은 전부 "클로드를 갈아치우는" 구조인데, 이것만 "클로드 옆에 얹는" 구조다.

---

## 1. 이미 가진 것 (동작 중)

| 항목 | 내용 |
|---|---|
| 위치 | `~/.local/share/claude-router/` |
| 진입점 | `router.py` (13KB, 순수 Python 3, 의존성 없음) |
| 상주 | launchd `com.pbj.claude-router` (KeepAlive) |
| 설정 | `models.json`(앱 피커 목록) · `triggers.json`(클로드 슬롯→GPT 모델 매핑) |
| 인증서 | 자체 생성 `ca.pem`/`leaf.pem` — **키체인에 설치 안 함** |
| 앱 연결 | `~/.claude/settings.json` env의 `HTTPS_PROXY=http://127.0.0.1:8790` + `NODE_EXTRA_CA_CERTS` |

### 핵심 구조 (`router.py` 9~11줄)

```
CONNECT api.anthropic.com -> TLS terminated here (leaf.pem) -> per-request:
    model in triggers.json -> model rewritten, sent to proxenos (plain HTTP)
    otherwise              -> forwarded byte-for-byte to api.anthropic.com
```

**선택적 가로채기**다. 이 한 줄이 경쟁자와의 모든 차이를 만든다.

### 현재 매핑 (`triggers.json`)

```
claude-opus-4-8   -> gpt-6-astra
claude-opus-4-7   -> gpt-5.6-sol
claude-opus-4-6   -> gpt-5.6-terra
claude-sonnet-4-6 -> gpt-5.6-luna
```

앱의 기본 모델 피커가 그대로 GPT 피커가 된다. 앱의 추론 강도 선택도 전달된다(`ultra`만 `max`로 깎음).

---

## 2. 검증된 기술 사실 (문서 근거 있음)

### ① 이 경로는 꼼수가 아니다 — 앤트로픽이 열어준 문이다

[Enterprise network configuration](https://code.claude.com/docs/en/corporate-proxy):

> Claude Desktop 세션에서 앱이 프로바이더 연결을 관리하는 경우, Claude Code는 이 변수들과 프록시 변수 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`를 **managed settings와 `~/.claude/settings.json`에서만** 읽는다. (…) **v2.1.217 이전에는 앱이 연결을 관리할 때 모든 설정 파일에서 이 변수들을 무시했다.**

- 예전엔 안 먹혔는데 **특정 버전에서 일부러 먹게 바꿨다.**
- 변경 방향은 "없애기"가 아니라 **"남기되 범위를 좁히기"** — 저장소 설정 파일에서는 못 읽게 하고 `~/.claude/settings.json`에서만 읽게 했다(악성 저장소의 경로 탈취 방지).
- `NODE_EXTRA_CA_CERTS`도 같은 문서 "Custom CA certificates"에 정식 수록. "기업용 TLS 감청 프록시는 추가 설정 없이 동작한다"고 명시. Zscaler·Netskope 제품명까지 나온다.
- **결론: 닫으면 유료 기업 고객이 깨진다. 스위치로 끌 수 있는 성격이 아니다.**

### ② 앱은 `ANTHROPIC_BASE_URL`을 읽지 않는다

[LLM gateway 문서 "Desktop app" 절](https://code.claude.com/docs/en/llm-gateway-connect):

> The desktop app reads gateway routing from its third-party inference configuration, **not from `ANTHROPIC_BASE_URL` or `settings.json`**.

### ③ 공식 게이트웨이 경로는 있다 — 그리고 대가가 크다

경로: Help → Troubleshooting → Enable Developer Mode → Developer → **Configure Third-Party Inference** → 게이트웨이 base URL 입력.

같은 문서가 대가를 명시한다:

> 게이트웨이 설정이 활성화되면 데스크톱 앱은 **로컬 머신에서만** 세션을 돌린다. 환경 선택기가 SSH 세션과 Anthropic 호스팅 클라우드 환경을 제공하지 않으며, **Remote Control을 쓸 수 없다.**

추가로 게이트웨이가 **모든 트래픽을 받는다.** API Key 자리에 더미(`proxy`)를 넣는 구조이므로 앱이 claude.ai로 인증하지 않는다 → **앱 안의 클로드 자체를 잃는다.**

### ④ 인증서는 키체인에 안 깐다

`NODE_EXTRA_CA_CERTS`는 "이 파일 하나만 추가로 믿어라"를 Node에게 직접 주는 변수다. 맥 전체 신뢰 저장소를 건드리지 않고, 관리자 비밀번호도 안 묻고, 다른 프로그램에 영향이 없다. 키체인 검색으로 `pbj claude-router local CA` 미등록 확인함.

**→ 배포 문턱이 낮다.** 사용자가 할 일은 설정 파일에 두 줄 넣기(자동화 가능).

---

## 3. 경쟁 지형 (2026-09-11 GitHub 실측)

### 앱을 노리는 놈들

| 저장소 | ⭐ | 방식 | 상태 |
|---|---|---|---|
| [Win-Hao/ModelLink](https://github.com/Win-Hao/ModelLink) | **135** | 공식 3P 추론 설정 + Tauri GUI | 4개월, 1개월 전 푸시 |
| [LiteLLM-Labs/litellm-relay](https://github.com/LiteLLM-Labs/litellm-relay) | 110 | 릴레이 자동 셋업 | 활동 중 |
| [xqnode/claude-code-helper](https://github.com/xqnode/claude-code-helper) | 77 | `ANTHROPIC_BASE_URL` 주입 + 게이트웨이 | 3개월 전 푸시(정체) |
| [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy) | 53 | Cloudflare Worker | 2개월 전 푸시 |
| [Coherence-Daddy/use-ollama-to-enhance-claude](https://github.com/Coherence-Daddy/use-ollama-to-enhance-claude) | 49 | Ollama 경유 | — |
| [EasyCode-Obsidian/Stone](https://github.com/EasyCode-Obsidian/Stone) | 21 | 로컬 게이트웨이 | — |

### 비교군 (CLI를 노리는 놈들)

| 저장소 | ⭐ | 비고 |
|---|---|---|
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | **37,180** | `ANTHROPIC_BASE_URL`만 씀. MITM 불필요. **CLI 전용.** Kimi(Moonshot) 후원 |
| [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) | 14,300 | README 스폰서 2곳(OrcaRouter·PackyCode) |

### 읽어야 할 숫자: 135 vs 37,180

앱 니치는 **최소 여섯 명이 붙었고 최고가 135**다. CLI의 0.4%.

두 해석:
- **A — 수요가 작다.** CLI 사용자는 토큰값에 민감해 모델을 갈아끼울 동기가 강하고, 앱 사용자는 구독료를 이미 냈으니 그냥 쓴다.
- **B — 배포가 갇혔다.** 여섯 개 중 넷이 중국 시장 전용. ModelLink은 README가 중국어, 붙이는 모델이 DeepSeek·Kimi·GLM·MiniMax·百炼, **홍보 채널이 GitHub이 아니라 틱톡(douyin)**. 영어권에 닿은 물건이 사실상 없다.

**B에 무게를 둔다.** ModelLink 실사용자는 스타보다 훨씬 많을 것(틱톡 배포는 스타를 안 누른다). 즉 135는 시장 크기가 아니라 **GitHub 도달률** 지표다.

### ModelLink 정밀 관찰 (가장 위험한 경쟁자)

**강함:** Tauri v2 + React 전면 재작성, 트레이 상주, macOS·Windows, 서비스사 8개 프리셋(브랜드 아이콘), 모델 매핑 시각화 보드, 요청 로그 100건, 앱 내 자동 업데이트, 포트 변경 가능. 취미 수준 아님.

**약점 둘:**
1. **라이선스가 CC BY-NC-ND 4.0** — 비상업 + 2차창작 금지. 오픈소스가 아니라 무료 배포 바이너리. 기여자 안 붙고, 포크 막히고, **스폰서 모델이 구조적으로 불가.** 작가는 틱톡 팔로워로 수익화한다.
2. **공식 게이트웨이 경로를 쓴다** → §2③의 대가를 사용자가 전부 지불한다. README 89~91줄에 `Developer → Configure third-party inference`, `Gateway URL: http://127.0.0.1:5678`, `API Key: proxy`가 그대로 적혀 있다.

---

## 4. 포지셔닝 (주군 결정)

### 팔아야 하는 한 문장

> **클로드를 끄지 않고 다른 AI를 옆에 붙인다. 개발자 모드도, 잃는 기능도 없다.**

경쟁자 = **"클로드 구독 없는 사람용 대체품"**
이것 = **"클로드 구독자용 증설품"**

Max와 ChatGPT를 둘 다 결제하는 사용자는 영어권에 널렸고 돈이 있다. 저쪽이 겨누는 시장이 아니다.

### 주군 방침 (이번 세션에서 확정)

1. **프로바이더는 많을수록 좋다.** 여러 AI를 쓰는 사람이 실제로 있고, 붙이는 만큼 들어오는 문이 늘어난다. (Claude의 "개수는 moat가 아니다"는 지적은 *방어력* 이야기였고, 주군의 판단은 *도달 범위* 이야기다 — 둘 다 유효하고 둘 다 필요하다.)
2. **OpenAI 구독 교차 사용은 문제 아니다.** GPT는 이미 어디서 쓰든 상관없게 풀어놨다. (Claude가 이 점을 모르고 ToS 경고를 올렸음 — 철회.)

### 비어 있는 세 자리

1. **영어권 배포** — 경쟁자 전부 중국어권. 영어 README + Reddit r/ClaudeAI + HN이 백지다.
2. **오픈 라이선스** — MIT로 열면 기여자·포크·스폰서가 다 가능. ModelLink은 NC-ND로 자기 발을 묶었다.
3. **스폰서 자리** — opencodex 사례로 보면 릴레이·게이트웨이 업체가 돈을 낸다. ModelLink은 라이선스 때문에 못 받는다.

### 수익 참고치 (opencodex 기준, 추정)

- 가격 비공개("Pricing is by inquiry; there is no public rate card"), 문의처는 X `@claudeebum` / 디스코드 / `jun@lidgeai.com`
- 티어: Main(모델 개발사 전용, 배너 1개) / Standard(릴레이·게이트웨이·리셀러, README 표 한 줄 + CLI 내장 프리셋 + 문서 상세페이지)
- 20,000 스타 도달 전 계약분은 가격 고정 — **아직 슬롯이 남아돈다는 신호**
- 개발자 대상 README 배너 시세 역산: **슬롯당 월 $300~1,500.** 2슬롯이면 월 $600~3,000(100만~400만 원대)
- Main 티어는 사실상 공석일 것 — 앤트로픽·OpenAI가 릴레이 광고 옆에 로고를 걸 이유가 없다

---

## 5. 미확인 — 다음에 확인할 것

### ★ 최우선: 적용 범위 비교

- ModelLink의 공식 3P 추론 설정은 **앱 전체(일반 채팅 포함)**에 걸릴 가능성이 있다.
- 주군의 프록시는 **Code 탭(Claude Code 프로세스)**에만 걸린다.
- **저쪽이 일반 채팅창에서도 다른 모델을 쓸 수 있다면 그건 저쪽 강점이다.** 아직 추측이다.
- 앱 바이너리(asar)에서 3P 추론 설정의 적용 지점을 보면 갈린다. ModelLink을 깔 필요 없음.
- **이 답이 제품 경계를 확정한다.**

### 그 외

- 일반 채팅까지 잡을 수 있는지(가능하면 시장이 개발자 밖으로 넓어진다)
- 앱 업데이트 내구성 — 깨지는 지점과 자동 복구 방법
- proxenos 의존을 걷어내고 범용 프로바이더 어댑터로 일반화하는 설계
- 사용자 설치 자동화(설정 두 줄 주입 + CA 생성 + launchd 등록)의 형태 — CLI냐 GUI냐
- 라이선스 확정(MIT 권장)

---

## 6. Claude가 이번 세션에서 틀린 것 (다음 세션이 반복하지 않도록)

1. **"CA 인증서를 키체인에 깔아야 하는 게 최대 벽"** → 틀림. `NODE_EXTRA_CA_CERTS`라 키체인 무관. 실제 설정 파일 확인 후 정정.
2. **"꼼수라서 앤트로픽이 피닝 걸면 즉사"** → 틀림. v2.1.217에서 의도적으로 열어준 공식 경로. 엔터프라이즈 TLS 감청 때문에 닫기 어렵다.
3. **"프로바이더 개수는 차별점이 아니다"** → 절반만 맞음. moat는 아니지만 도달 범위다. 주군 지적으로 정정.
4. **"구독 교차 사용은 OpenAI ToS 위험"** → 철회. GPT는 이미 풀렸다.

**교훈: 추측을 단언으로 내지 말고 문서·파일을 먼저 열 것.** 이 브리프의 §2는 전부 1차 문서 인용이다.
