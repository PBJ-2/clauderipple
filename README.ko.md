<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center">
  <b>AI 코딩 도구와 모델을 전부 잇는 로컬 프록시 하나.</b><br>
  <b>Claude Desktop</b>과 <b>Claude Code</b> 안에서 GPT·DeepSeek·Kimi·Grok 등 40여 프로바이더를 쓰고,
  <b>Codex CLI</b>에서는 Claude를 씁니다. 아무것도 끄지 않고요.
</p>

<p align="center">
  <a href="https://github.com/PBJ-2/clauderipple/releases"><img alt="Release" src="https://img.shields.io/github/v/release/PBJ-2/clauderipple?include_prereleases&label=download"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/docs-English-blue"></a>
</p>

<p align="center">
  <img src="docs/media/tour.png" width="880" alt="ClaudeRipple 설정 화면 둘러보기">
</p>

<table align="center">
  <tr>
    <td align="center" width="34%"><img src="docs/media/picker-zoom.png" width="300" alt="Claude Desktop 피커에 실제 이름으로"><br><sub>Claude Desktop 피커에 실제 이름으로</sub></td>
    <td align="center" width="66%"><img src="docs/media/luna-answer.png" alt="GPT-5.6 Luna가 자기 이름으로, 고른 강도로 답하는 장면"><br><sub>GPT-5.6 Luna가 자기 이름으로, 고른 강도로 답하는 장면</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/media/subagents.png" alt="GPT-5.6 Terra와 Sol로 도는 서브에이전트가 패널에 이름표로 표시"><br><sub>GPT-5.6 Terra와 Sol로 도는 서브에이전트가 패널에 이름표로 표시</sub></td>
  </tr>
</table>

---

## 왜 만들었나

Claude Desktop의 공식 "서드파티 추론" 설정은 앱 전체를 다른 모드로 바꿉니다. claude.ai
채팅, 원격 제어, 클라우드 세션을 잃습니다. `ANTHROPIC_BASE_URL`을 바꾸는 도구는 데스크톱
앱에 아예 닿지 못하고, ChatGPT로 번역해 주는 도구들은 프롬프트 캐시를 자주 깨뜨립니다
(유명한 것 하나를 측정하니 캐시 적중 12~20%, 입력 토큰 비용 8배).

ClaudeRipple은 다른 길로 갑니다. Claude Code 프로세스만 신뢰하는 아주 작은 HTTPS
프록시입니다. 매핑한 모델의 요청만 프로바이더로 가고, 나머지는 바이트 그대로 Anthropic으로
갑니다. 다른 건 아무것도 바뀌지 않습니다.

| | ClaudeRipple | opencodex 계열 | Desktop 3P 설정 |
|---|---|---|---|
| Claude Desktop Code 탭 | ✅ | 3P 설정을 켜야 함 | ✅ |
| claude.ai 채팅·원격 제어·클라우드 세션 유지 | ✅ | ❌ | ❌ |
| Claude 구독과 GPT 구독 동시 사용 | ✅ | ❌ (전부 아니면 전무) | ❌ |
| Desktop 피커에 실제 모델 이름 | ✅ | ❌ | 일부 |
| 번역 프로바이더의 프롬프트 캐시 | **94~99%** 실측 | 12~20% 실측 | 해당 없음 |
| 터미널 `claude`, 모바일 원격 제어 | ✅ | ✅ / ❌ | ✅ |
| Codex CLI → Claude 및 다른 프로바이더 | ✅ | ✅ | ❌ |
| 비개발자용 설정 GUI | ✅ | 일부 | ❌ |

## 할 수 있는 것

- **Claude Desktop 피커에서 GPT-5.6 Terra·Sol·Luna, GPT-6 Astra를 실제 이름으로 선택.**
  ChatGPT Plus/Pro 구독으로 씁니다. 원하면 Claude 이름에 다른 모델을 매핑하고 피커는 그대로 둘 수도 있습니다.
- **어떤 프로바이더든.** ChatGPT 구독, DeepSeek, Kimi(Moonshot), Z.ai GLM, MiniMax, Qwen,
  OpenRouter(400여 모델), xAI Grok, Mistral, Groq, Together, Fireworks, Ollama·LM Studio(로컬).
  프리셋을 고르고 키를 붙여 넣으면 연결 확인과 모델 목록 불러오기가 한 번에 됩니다.
- **어떤 클라이언트든.** Claude Desktop, 터미널 `claude`(`/model gpt-5.6-terra`), 모바일 원격 제어,
  그리고 로컬 OpenAI 호환 입구를 통한 **Codex CLI**(`clauderipple codex on`).
- **정확하게.** 프롬프트 캐시 보존, Claude Code의 서버측 스레드 처리, 도구 호출·이미지 왕복,
  모델마다 받는 추론 강도로 자동 조정.
- **제대로 된 요청 로그.** 누가 어떤 모델을 호출했고 어떤 모델이 답했는지, 입력·캐시·출력 토큰, 소요 시간, 상태.
- **서브에이전트 이름표.** 백그라운드 작업 패널에 "Agent" 대신 `Terra·high · 리뷰`.
- **메뉴 막대 앱.** 실행 환경을 스스로 갖고 첫 실행 때 설정을 대신 합니다. 서명·공증 완료.

<p align="center">
  <img src="docs/media/mapping.png" width="880" alt="모델 매핑">
</p>

## 설치 (macOS)

1. [Releases](https://github.com/PBJ-2/clauderipple/releases)에서 `ClaudeRipple-<버전>-arm64.dmg`(Apple Silicon)
   또는 `-x64.dmg`(Intel)를 받습니다.
2. 응용 프로그램 폴더에 끌어 넣고 엽니다. 첫 실행 때 로컬 인증서, `~/.claude/settings.json` 두 줄,
   로그인 시 시작되는 백그라운드 라우터 설정을 대신 해 줍니다. Node 설치는 필요 없습니다.
3. 메뉴 막대 아이콘 → **ClaudeRipple 열기…** → **프로바이더**에서 ChatGPT를 추가하거나 API 키를 붙여 넣고 → **모델 매핑**.

Desktop 피커에 실제 이름을 띄우려면 **클라이언트 → Claude Desktop → 모델 피커 켜기**.
macOS가 로컬 인증서 신뢰를 위해 로그인 암호를 한 번 묻습니다(ClaudeRipple은 암호를 보지 않습니다).
그 뒤 Claude Desktop을 완전히 껐다 켜면 됩니다.

<details>
<summary>소스에서 설치 (Node 24)</summary>

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install   # 인증서, settings.json, launchd, 종단 검사
node packages/cli/src/index.ts ui        # 브라우저에서 GUI 열기
```

`uninstall`은 전부 되돌리고 `~/.claude/settings.json`을 백업에서 복원합니다.
그 밖의 명령: `status`, `start`, `stop`, `restart`, `logs -f`, `login`, `logout`,
`claude-login`, `claude-logout`, `picker on|off`, `agent-title on|off`, `codex on|off`.
</details>

## 클라이언트

### Claude Desktop과 Claude Code

설치하면 바로 됩니다. **모델 매핑**에서 매핑을 정하거나(자동 저장), **피커 모드**를 켜서 앱 피커에
프로바이더 모델을 실제 이름으로 띄우세요. 서브에이전트도 같은 규칙을 따르고, 프롬프트에
`[[gpt: sol@xhigh]]` 표식을 넣으면 그 호출만 모델을 바꿉니다.

### 터미널 `claude`

같은 라우터, 같은 매핑입니다. `/model gpt-5.6-terra`로 추가한 모델이 목록에 나옵니다.

### Codex CLI

```bash
clauderipple codex on          # ~/.codex/config.toml에 "clauderipple" 프로바이더 추가(백업 먼저)
codex --profile clauderipple -m claude-sonnet-5        # 터미널. Codex 앱에서도 됩니다
```

Claude는 Claude Code 로그인(실행 중인 Desktop 세션, 터미널 로그인, 또는 `clauderipple claude-login`으로
만든 토큰)이나 Anthropic API 키로 연결됩니다. 구독 로그인 재사용은 Anthropic 약관의 적용을 받습니다.
설정해 둔 Anthropic 호환 프로바이더도 같은 방법으로 쓸 수 있습니다.

<p align="center">
  <img src="docs/media/add-provider.png" width="880" alt="프로바이더 추가">
</p>

## 프로바이더

| 프로바이더 | 종류 | 인증 | 모델 목록 | 비고 |
|---|---|---|---|---|
| ChatGPT 구독 | Codex 백엔드 | 로그인(또는 Codex CLI 로그인 재사용) | Terra, Sol, Luna, Astra | effort low~max(Luna는 ultra), 캐시 94~99% |
| OpenRouter | Anthropic 호환 | API 키 | 400여 개 자동 | 모델별 강도 지원을 API에서 읽음 |
| DeepSeek, Kimi, Z.ai GLM, MiniMax, Qwen(국제/중국) | Anthropic 호환 | API 키 | 프리셋 | 공식 문서 기준 검증 |
| xAI Grok, Mistral, Groq, Together, Fireworks | OpenAI 호환 | API 키 | 자동 | 번역(Chat Completions / Responses) |
| Ollama, LM Studio | OpenAI 호환, 로컬 | 없음 | 자동 | |
| Anthropic | 네이티브 | Claude Code 로그인 또는 API 키 | Claude 모델 | Codex 입구용 |
| 그 외 | 직접 입력 | 자유 | 자동 | Anthropic·OpenAI 호환 엔드포인트 아무거나 |

호환 프로바이더로 나가는 요청에서는 Anthropic 전용 항목(서버측 스레드, 지연 로딩 도구, 문맥 관리,
사고 바인딩)을 떼고 강도를 모델 단위로 맞춰, Claude Code의 요청 형태 때문에 400이 나지 않게 합니다.

## 동작 원리

```
Claude Desktop / claude CLI ──HTTPS_PROXY──▶ ClaudeRipple ──▶ api.anthropic.com   (그대로)
                                               │
                        매핑한 모델 ───────────┼──▶ chatgpt.com/backend-api (Responses ⇄ Messages)
                                               ├──▶ Anthropic 호환 벤더 (+ 호환 계층)
                                               └──▶ OpenAI 호환 벤더 (Messages ⇄ Chat/Responses)
Codex CLI ──/v1/responses──▶ ClaudeRipple 입구 ──▶ Claude(로그인 또는 API 키) / 벤더
```

- Claude Code CLI는 `~/.claude/settings.json`의 `HTTPS_PROXY`와 `NODE_EXTRA_CA_CERTS`를 읽습니다
  (Anthropic이 문서화한 기업 프록시 경로). 그 프로세스만 로컬 인증기관을 신뢰하고, 피커 모드를
  켜지 않는 한 OS 키체인은 건드리지 않습니다.
- 피커 모드는 앱 자체의 claude.ai 트래픽을 프록시로 보내고, 앱이 시작할 때 받아가는 피커 목록에
  모델을 추가합니다. 한 번의 클릭으로 원상복구됩니다.
- 라우터는 재시작 시 진행 중 호출을 기다리고, 업스트림 장애가 반복되면 스스로 종료해 launchd가
  다시 띄우게 하며, 로그를 회전하고, 요청을 조용히 잃지 않습니다.

근거와 세부는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에 있습니다.

## 개인정보

모든 것이 127.0.0.1에서 돕니다. API 키는 `~/.clauderipple/config.json`(0600)에만 있습니다.
네트워크 목적지는 설정한 프로바이더뿐이고, 원격 측정은 없습니다.

## 상태

알파. 제작자가 매일 씁니다. 지금은 macOS, Windows는 [로드맵](docs/ROADMAP.md)에 있습니다.
ChatGPT와 OpenRouter는 실제 키로 검증했고, 다른 프리셋은 벤더 공식 문서 기준입니다.

## 비제휴

ClaudeRipple은 독립 오픈소스 프로젝트이며 Anthropic·OpenAI와 제휴·보증·후원 관계가 없습니다.
Claude와 Claude Code는 Anthropic, PBC의 상표이고, ChatGPT와 Codex는 OpenAI의 상표입니다.

## 라이선스

MIT — [LICENSE](LICENSE).
