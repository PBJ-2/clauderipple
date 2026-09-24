<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<p align="center">
  <b>채팅은 Claude 그대로. Code만 GPT로.</b><br>
  Claude Desktop의 타모델 설정은 <b>앱 전체</b>를 바꿔 버립니다. 채팅도, 폰 원격 조종도, 커넥터도 같이 사라집니다.<br>
  ClaudeRipple은 아무것도 끄지 않습니다. Claude 구독에 로그인한 그대로 두고, <b>Code 탭</b>에서만
  GPT·DeepSeek·Kimi·Grok 등<br>400여 모델이 답합니다. <b>Codex 앱</b>과 <b>Codex CLI</b>에서는 반대로 Claude를 씁니다.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clauderipple"><img alt="npm" src="https://img.shields.io/npm/v/clauderipple?label=npm"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-orange">
  <a href="LICENSE"><img alt="GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-arm64%20%7C%20x64-0078D4">
  <img alt="Node" src="https://img.shields.io/badge/node-24%2B-success">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/docs-English-blue"></a>
</p>

<p align="center">
  <img src="docs/media/tour.png" width="880" alt="ClaudeRipple 설정 화면: 상태, 모델 매핑, 프로바이더, 클라이언트, 요청 로그">
</p>

<table align="center">
  <tr>
    <td align="center" width="34%"><img src="docs/media/picker-zoom.png" width="300" alt="Claude Desktop 피커에 실제 이름으로"><br><sub>Claude Desktop 피커에 GPT 모델이 실제 이름으로</sub></td>
    <td align="center" width="66%"><img src="docs/media/luna-answer.png" alt="Code 탭에서 답하는 GPT-5.6 Luna"><br><sub>Code 탭에서 고른 추론 강도 그대로 답하는 GPT-5.6 Luna</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/media/subagents.png" alt="백그라운드 작업 패널에 실제 모델 이름으로 표시된 서브에이전트"><br><sub>GPT-5.6 Terra·Sol로 도는 서브에이전트, 작업 패널에 실제 이름으로</sub></td>
  </tr>
</table>

---

## 1P냐 3P냐 — 이 프로젝트가 존재하는 이유

Claude Desktop에는 다른 모델을 쓰는 공식 경로가 이미 있습니다. **추론 게이트웨이** 설정, 앱이 타사(3P)라고
부르는 모드입니다. 문제는 그게 세션별 선택이 아니라는 것입니다. 앱 전체가 **실행 시점에** 다른 배포 모드로
뜨고, 그 모드는 사실상 다른 제품입니다.

- 창이 `claude.ai`를 더 이상 불러오지 않고 로컬 번들을 띄웁니다. claude.ai의 `/api/`·`/v1/` 호출은
  `custom_3p_not_available` 503으로 막힙니다.
- "채팅"이 claude.ai 채팅이 아닙니다. Claude Code 로컬 에이전트 세션입니다.
- Remote Control과 사이드 세션이 아예 꺼집니다(`shouldEnableSessionsBridge()`가 false).
- Anthropic이 만든 claude.ai 커넥터, Claude Design, 모바일 연동, 채팅 검색도 함께 사라집니다.

중간 설정은 없습니다. "채팅은 Claude로, Code는 게이트웨이로"는 누구도 할 수 없습니다. 1P 모드는 게이트웨이로
아무것도 보내지 않기 때문입니다. (전부 앱 번들을 직접 읽어 확인한 것입니다. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2)

**ClaudeRipple은 그 설정을 건드리지 않습니다.** 앱은 Claude 구독에 로그인된 1P 상태 그대로 있고, Code 탭과
서브에이전트에서만 다른 모델이 답합니다. 모델 피커에 실제 이름으로 뜨고, 고른 추론 강도가 그대로 전달됩니다.
Claude 계정을 GPT 계정과 맞바꾸는 것이 아니라, **한 앱에서 둘 다 갖는 것**입니다.

1P에 남았기 때문에 되는 일이 셋 있습니다. 게이트웨이를 쓰는 도구는 어느 것도 줄 수 없습니다.

- **폰에서 GPT에게 코딩 시키기.** 3P는 Remote Control을 끕니다. 여기서는 켜져 있으니, 침대에서 모델을 고르고
  일을 시키고 커밋이 올라오는 것을 봅니다.
- **커넥터를 붙인 채로 다른 모델 쓰기.** 3P는 claude.ai 호출을 막아 Anthropic이 만든 커넥터까지 함께 죽입니다.
  구글 드라이브 문서를 읽으면서 GPT로 코딩하는 것은 1P에서만 됩니다.
- **클라우드 세션과 사이드 세션.** 3P에서는 사라집니다. 여기서는 그대로입니다.

Claude에 돈을 내고 있다면 3P는 선택지가 아닙니다. 낸 돈의 절반을 버리는 일이기 때문입니다.
그 돈을 지키면서 모델을 고르는 방법은 이것뿐입니다.

## 자주 묻는 질문

### 클로드 데스크톱 앱에서 GPT를 쓸 수 있나요?

됩니다. **Code 탭**과 그 서브에이전트에서 됩니다. ClaudeRipple을 설치하고 ChatGPT Plus나 Pro 구독으로
로그인하면, GPT(챗GPT의 GPT-6 Sol·Luna·Astra, GPT-5.6 Terra 등)가 모델 피커에 실제 이름으로 뜨고, 고른 추론 강도
그대로 답합니다. 앱 자체는 고치지도 않고, 다른 모드로 바꾸지도 않습니다. 일반 **채팅** 탭은 Claude 그대로입니다.
채팅까지 바꾸려면 앱 전체를 게이트웨이 모드로 돌려야 해서 어떤 도구도 못 합니다([1P냐 3P냐](#1p냐-3p냐--이-프로젝트가-존재하는-이유) 참고).

### Claude Code(터미널)에서 GPT를 쓰려면요?

같은 설치로 함께 됩니다. ClaudeRipple은 로컬 프록시이고, `~/.claude/settings.json`에 두 줄을 넣어
Claude Code가 그쪽을 보게 합니다. 스킬·훅·MCP 서버·`CLAUDE.md`·서브에이전트는 그대로 살아 있습니다.

### 클로드 앱의 "서드파티 추론"(게이트웨이) 설정을 켜야 하나요?

아니요. 켜면 안 됩니다. 그 설정은 앱 전체를 3P 모드로 바꿔서 claude.ai를 더 이상 불러오지 않고,
채팅을 로컬 에이전트 세션으로 대체하며, Remote Control을 끕니다. ClaudeRipple은 그 설정을 건드리지 않습니다.

### claude.ai 채팅이나 폰 원격 조종, 커넥터를 잃나요?

잃지 않습니다. 앱은 Claude 구독에 로그인된 채로 있어서 채팅, 폰 Remote Control, 클라우드 세션,
Anthropic이 만든 커넥터가 전부 그대로 동작합니다. 1P에 남는 이유가 이것입니다.

### Claude 자체도 계속 쓸 수 있나요?

쓸 수 있습니다. 매핑은 모델 이름 단위입니다. 어떤 이름을 Claude에 그대로 두면 그 이름은 Claude가 답합니다.
보통 한두 개만 GPT로 바꾸고 나머지는 그대로 둡니다.

### OpenAI API 키가 필요한가요?

필요 없습니다. ChatGPT Plus나 Pro 구독이면 됩니다. 앱에서 로그인하면 되고 API 키는 쓰지 않습니다.
API 키는 DeepSeek·Kimi·GLM·OpenRouter처럼 다른 프로바이더를 붙일 때만 씁니다.

### 어떤 모델을 쓸 수 있나요?

ChatGPT 구독으로 GPT를 쓰고, OpenRouter나 직접 API 키로 DeepSeek·Kimi·GLM·Grok·Qwen 등 400개가 넘는
모델을 씁니다. Claude 모델은 그대로 남아 있습니다.

### 윈도우에서도 되나요?

됩니다. macOS와 Windows, arm64와 x64 모두. 설치·대시보드·재시작·제거를 Windows 11 arm64에서 실측했고,
x64 런타임은 에뮬레이션으로 확인했습니다. systemd 사용자 세션이 있는 Linux에서도 됩니다. 설치, 라우터를 거친
Code 탭 요청, 스트리밍 응답 도중의 재시작, 제거를 Ubuntu 24.04 x64와 Claude Desktop 2.2553.13에서
실측했습니다. Linux에서는 아직 피커 모드를 쓸 수 없습니다.

### 제 코드가 다른 데로 가나요?

가지 않습니다. 프록시는 내 컴퓨터에서 돕니다. 요청은 설정한 프로바이더로만 가고, 자격증명은
홈 디렉터리에만 저장됩니다. [개인정보](#개인정보) 절을 보세요.

### Claude 계정이 정지(밴)되지 않나요? 약관 위반 아닌가요?

ClaudeRipple이 Claude에 하는 일은 작고 확인할 수 있습니다. Claude로 가는 요청은 Claude Code가 보낸 그대로
한 바이트도 바꾸지 않고 나가고, GPT 등 다른 프로바이더로 보낸 요청은 Anthropic에 아예 가지 않습니다. 앱을 고치는
방식이 아니라, Claude Code가 회사 네트워크용으로 문서화해 둔 프록시·인증서 설정(`HTTPS_PROXY`,
`NODE_EXTRA_CA_CERTS` — 공식 문서 [Enterprise network configuration](https://code.claude.com/docs/en/corporate-proxy))을 씁니다. 계정 정지 사례로 알려진 것은 반대 방향, 즉 Claude 구독 로그인을 **다른 프로그램**에서
쓰는 경우입니다. ClaudeRipple에도 그런 선택 기능이 하나 있습니다. Codex 안에서 Claude를 구독 로그인으로 쓰는
것인데, 이는 Anthropic 약관의 적용을 받습니다. Anthropic API 키로 쓰면 이 문제가 없습니다. Claude 구독 여러 개를
돌려 쓰는 것도 같은 약관 아래 각자 판단할 일입니다. 계정을 어떻게 다룰지는 Anthropic만 정할 수 있으니, 여기 적은
내용은 보장이 아닙니다.

### ChatGPT 계정을 여러 개 쓸 수 있나요?

됩니다. `clauderipple login`을 할 때마다(또는 대시보드의 **+ ChatGPT 계정 추가**) 계정이 하나씩 늘어납니다.
한 계정이 한도에 걸리면 같은 요청을 다음 계정이 이어받고, 한도가 찬 계정은 풀릴 때까지 쉽니다. 대화는 답한 계정에
고정되어 프롬프트 캐시를 지킵니다. Claude Desktop Code 탭, Claude Code, Codex 앱·CLI의 GPT에 모두 적용됩니다.

### Codex에서 Claude를 쓸 수 있나요?

됩니다. `clauderipple codex on`을 하면 ClaudeRipple이 프로바이더로 추가되고, Codex 앱과 CLI의 모델 목록에
Claude 모델이 이름 그대로 뜹니다. Claude Code 로그인이나 Anthropic API 키로 답합니다.
[Codex 앱과 Codex CLI](#codex-앱과-codex-cli) 절을 보세요.

### Claude Code 안에서는 GPT 성능이 떨어지지 않나요?

Claude Code의 시스템 프롬프트와 도구 설명은 Claude에 맞춰 쓰여 있어서, 다른 모델은 남에게 맞춘 지시를 읽는 셈이고
자기 전용 앱에서와 조금 다르게 굴 수 있습니다. ClaudeRipple은 모델마다 자기 이름과 추론 강도를 알려 주고, 벤더가
거부할 도구 스키마를 고쳐 넘기며, 프로바이더별로 지시문을 덧붙일 수 있게 합니다. 흔한 구성은 Claude를 메인으로 두고
GPT나 DeepSeek을 서브에이전트로 쓰는 것입니다.

### opencodex나 claude-code-router와 뭐가 다른가요?

[비교표](#네-개-대신-하나)(2026-09-16 확인)를 보세요. 요약하면 ClaudeRipple은 앱이 Claude에 로그인된 채로 Claude
**데스크톱 앱**의 Code 탭에 들어가고, 다른 모델을 피커에 실제 이름으로 보여 줍니다.

### 무료인가요?

무료입니다. GPL-3.0 오픈소스입니다. 이미 쓰고 있는 구독이나 API 키 비용만 듭니다.

## 네 개 대신 하나

비슷한 도구들은 터미널용입니다. Claude Code CLI나 Codex CLI가 다른 모델을 쓰게는 해 주지만, Claude **데스크톱 앱**에는
닿지 못하고, 다른 모델로 바꾸는 순간 Claude 구독 쪽 기능(claude.ai 채팅, Remote Control, 클라우드 세션)을 잃습니다.
ClaudeRipple은 데스크톱 앱·터미널·Codex를 메뉴 막대 앱 하나로 다루고, 두 구독을 나란히 쓰며, Claude Code 하네스를
그대로 둡니다. 스킬·훅·MCP 서버·`CLAUDE.md`·서브에이전트·claude.ai 커넥터가 전부 살아 있는 채로 두뇌만 바뀝니다.

| | ClaudeRipple | opencodex / openclaude (2026-09-16 확인) | claude-code-router | Claude Desktop 게이트웨이(3P) 모드 |
|---|---|---|---|---|
| 게이트웨이(3P) 모드 **없이** Claude **Desktop** Code 탭 | ✅ | ❌ ¹ | ❌ | ❌ (정의상 불가) |
| claude.ai 채팅·Remote Control·클라우드 세션·커넥터 유지 | ✅ | ❌ | ❌ | ❌ |
| Claude 구독과 GPT 구독 나란히 | ✅ | ❌ 전부 아니면 전무 | ❌ | ❌ |
| Desktop 피커에 실제 모델 이름 | ✅ | ❌ | ❌ | 일부 |
| ChatGPT 계정 여러 개, 한도 차면 자동 전환 (Desktop·Codex) | ✅ | ✅ | ❌ | ❌ |
| 터미널 `claude` CLI | ✅ | ✅ | ✅ | ✅ |
| Codex **앱**·Codex CLI → Claude | ✅ | ✅ | ❌ | ❌ |
| 번역 프로바이더의 프롬프트 캐시 | **94~99 %** 실측 | 미측정 | 제각각 | 해당 없음 |
| 서브에이전트를 실제 모델 이름으로 표시 | ✅ | ❌ | ❌ | ❌ |
| 터미널 없이 쓰는 설정 GUI | ✅ | ❌ | ❌ | ❌ |
| 런타임 내장, 서명·공증된 앱 | ✅ | ❌ | ❌ | – |

¹ opencodex는 README에 Claude Desktop 데모를 걸어 두었지만, 저장소에도 문서 사이트에도 설치 절차가 없었습니다
(2026-09-16 확인). 당시 데스크톱 앱으로 들어가는 공개된 경로는 공식 게이트웨이 설정, 즉 마지막 칸뿐이었습니다.

데스크톱 앱의 "서드파티 추론" 설정은 앱 전체를 다른 모드로 바꿔 버립니다. claude.ai 채팅, Remote Control,
클라우드 세션을 잃습니다. `ANTHROPIC_BASE_URL`을 바꿔치기하는 도구들은 데스크톱 앱에 아예 닿지 못합니다.
ClaudeRipple은 Claude Code 프로세스만 신뢰하는 작은 HTTPS 프록시입니다. 매핑한 모델 요청만 프로바이더로 가고,
나머지는 Anthropic으로 바이트 그대로 지나갑니다.

## 할 수 있는 것

- **Claude Desktop과 Claude Code에서 어떤 모델이든.** ChatGPT Plus/Pro 구독으로 GPT-6 Sol / Luna / Astra와
  GPT-5.6 Terra / Sol / Luna를(OpenAI가 새 모델을 내면 그날 바로 뜹니다), 아니면 DeepSeek·Kimi·GLM·MiniMax·Qwen·Grok·Mistral·Groq·Together·Fireworks·OpenRouter(400+ 모델)·
  로컬 Ollama / LM Studio를. 피커에 실제 이름으로 띄우거나, Claude 이름에 매핑해서.
- **Codex 앱과 Codex CLI에서 Claude를.** Codex가 프로바이더로 인식하는 로컬 OpenAI 호환 엔드포인트. Claude 모델이
  Codex 자체 모델 목록에 뜹니다. 현재 Claude Code 로그인이나 Anthropic API 키를 씁니다.
- **프롬프트 캐시를 깨지 않는 Claude 다계정.** 네이티브 Claude 프로바이더에서 계정 자동 전환을 켜고 대시보드로
  구독 계정을 추가하면, 대화마다 답한 계정에 고정됩니다. 응답이 시작되기 전 한도·인증 거부가 오면 같은 요청을
  다음 계정으로 넘깁니다. 이 Claude Desktop/Code 원형 경로는 번역을 거치는 Codex 입구와 별개이며, Codex 쪽은
  사용 가능한 로그인 하나만 골라 쓰고 계정을 자동 전환하지 않습니다.
- **ChatGPT 계정 여러 개.** `clauderipple login`(또는 대시보드의 **+ ChatGPT 계정 추가**)을 할 때마다 계정이
  늘어납니다. 한 계정이 한도에 걸리면 같은 요청을 다음 계정이 이어받고, 그 계정은 한도가 풀릴 때까지 쉽니다.
  대화는 답한 계정에 고정되어 캐시를 지킵니다. Claude Desktop Code 탭·서브에이전트와 **Codex 앱·CLI의 GPT**에
  모두 적용됩니다. Codex는 로그인을 그대로 두고, 로그아웃·재로그인 없이 다음 계정으로 넘어갑니다.
- **Claude Code 하네스는 손대지 않습니다.** 스킬, 훅, MCP, `CLAUDE.md`, 서브에이전트, 플랜 모드, 휴대폰 Remote Control.
  아무것도 꺼지지 않습니다.
- **구조적으로 올바르게.** 프롬프트 캐시 보존(Anthropic 캐시 브레이크포인트, 고정된 OpenAI 프리픽스), Claude Code의
  서버 측 스레드 처리, 도구 호출과 이미지 왕복, 모델이 받는 범위로 추론 강도 클램프, 호환 벤더에는 Anthropic 전용 필드 제거.
- **제대로 된 요청 로그.** 누가 물었고 어떤 모델이 답했는지, 입력·캐시·출력 토큰, 지연, 상태를 요청마다. 한 시간 요약 포함.
- **서브에이전트 이름표.** 백그라운드 작업 패널에 "Agent" 대신 `Terra·high · Review`가 보입니다.
- **터미널이 싫은 사람을 위해.** 원클릭 연결 확인과 모델 자동 검색이 붙은 프로바이더 프리셋, 드롭다운 모델 매핑, 자동 저장,
  한국어·영어 UI. 런타임을 품고 첫 실행에 스스로 설치하는 메뉴 막대 앱. 서명·공증 완료.

<p align="center">
  <img src="docs/media/mapping.png" width="880" alt="모델 매핑: Claude 이름마다 실제로 답할 모델과 추론 강도">
</p>

## 설치

**macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.ps1 | iex
```

**Linux** (systemd가 있는 데스크톱 세션)

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

라우터는 사용자 단위 systemd 서비스로 돕니다. 상태는 `systemctl --user status clauderipple`, 출력은
`journalctl --user -u clauderipple`로 봅니다. Linux에서는 아직 피커 모드를 쓸 수 없습니다. 모델 매핑은
피커 없이도 됩니다.

준비물은 없습니다. 이미 Node 24 이상이 있으면 그것을 쓰고, 없으면 공식 빌드를 `~/.clauderipple/runtime`에
내려받습니다. 내려받은 파일은 nodejs.org가 공개한 체크섬과 대조합니다. 그다음 설치까지 마칩니다. 로컬 인증서,
`~/.claude/settings.json` 두 줄, 컴퓨터를 켤 때 함께 뜨는 백그라운드 라우터. 관리자 권한도, 암호 입력도 필요
없습니다.

Node가 이미 있으면 스크립트를 건너뛰어도 됩니다.

```sh
npm install -g clauderipple
clauderipple install
```

그다음 대시보드를 열어 프로바이더를 추가합니다.

```sh
clauderipple ui
```

**프로바이더** → ChatGPT 추가 또는 API 키 붙여 넣기 → **모델 매핑**.

**메뉴 막대·트레이 앱은 선택 사항입니다.** 라우터 상태를 보여주고 한 번에 대시보드를 엽니다.

```sh
clauderipple tray
```

Electron으로 도는데 용량이 270MB라 기본 설치에는 넣지 않았습니다. `clauderipple tray --install`이 한 번만
받아 옵니다. 나머지 기능은 Electron 없이도 다 돕니다.

**업데이트.**

```sh
npm install -g clauderipple@latest
clauderipple restart
```

선택 사항, Desktop 피커에 실제 이름을 띄우려면: **클라이언트 → Claude Desktop → 모델 피커 → 켜기**. 그다음 Claude
Desktop을 완전히 종료했다가 다시 엽니다. 로컬 인증서를 사용자 범위로만 신뢰시키는데, 이때 macOS는 로그인 암호를
묻고 Windows는 지문이 적힌 확인 창을 띄웁니다. ClaudeRipple은 암호를 보지 않으며, 양쪽 다 관리자 권한이 필요
없습니다.

> **Claude Desktop은 창을 닫아도 종료되지 않습니다.** 그 상태로 다시 열면 이전 인스턴스를 재사용해서 새 설정을
> 읽지 않습니다. 제대로 종료하십시오(macOS는 ⌘Q, Windows는 트레이 아이콘 또는 작업 관리자). 안 그러면 피커가
> 아무 말 없이 그대로입니다.

<details>
<summary>소스에서 (Node 24)</summary>

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install   # 인증서, settings.json 환경, launchd 에이전트, 엔드투엔드 점검
node packages/cli/src/index.ts ui        # 브라우저에서 로컬 GUI 열기
```

`uninstall`은 전부 되돌리고 `~/.claude/settings.json`을 백업에서 복원합니다. 그 밖의 명령: `status`, `start`, `stop`,
`restart`, `logs -f`, `login`, `logout`, `claude-login`, `claude-logout`, `picker on|off`, `agent-title on|off`,
`codex on|off`.
</details>

## 클라이언트

### Claude Desktop

설치 후 바로 됩니다. **모델 매핑**에서 매핑하거나(자동 저장), **피커 모드**를 켜서 앱 자체 피커에 프로바이더 모델을
실제 이름으로 띄웁니다. 앱에서 고른 추론 강도는 그대로 전달되고, 모델이 못 받는 강도는 가장 가까운 값으로 맞춥니다.

### Claude Code (터미널, Remote Control, 서브에이전트)

같은 라우터, 같은 매핑. `/model gpt-5.6-terra`에 추가한 모델이 나열됩니다. 서브에이전트도 같은 라우팅을 따르고,
프롬프트에 `[[gpt: sol@xhigh]]` 표식을 넣으면 그 호출만 모델을 바꿉니다. 작업 패널에는 실제 모델 이름이 보입니다.

**이걸 쓰려고 하네스를 따로 짤 필요는 없습니다.** 서브에이전트 슬롯을 라우팅된 모델로 지정하면
모든 서브에이전트가 그 모델로 돕니다. 에이전트 파일도, 다른 것도 필요 없습니다.

```jsonc
// 설정 → CLI 모델, 또는 설정 파일의 "cli": { "models": { … } }
{ "subagent": "gpt-5.6-terra" }   // → CLAUDE_CODE_SUBAGENT_MODEL
```

**체크한 모델은 곧 이름 붙은 서브에이전트입니다.** 프로바이더 하나만 들고 있는 모델마다 라우터가
`~/.claude/agents/<이름>.md`를 씁니다(`gpt-5.6-terra` → `gpt-5-6-terra`, `deepseek-v4.1-flash` →
`deepseek-v4-1-flash`). 그래서 "딥시크한테 시켜"에 필요한 건 모델 체크뿐입니다 — Agent 도구 목록에 뜨고,
`subagent_type: "deepseek-v4-1-flash"`로 돌고, 작업 패널에 그 이름이 보입니다. 체크를 빼면 파일도 사라집니다.
라우터는 자기가 쓴 파일만 건드리고(`generated-agents.json`에 기록), 같은 이름으로 직접 쓴 파일이 있으면
그쪽이 이기므로, 지시를 따로 주고 싶으면 Claude Code 에이전트 파일에 라우터가 아는 `model:`만 적으면 됩니다:

```markdown
---
name: reviewer
description: GPT-5.6 Sol로 독립 리뷰.
model: gpt-5.6-sol@medium
---
너는 이 세션의 리뷰어다. 변경을 직접 검증해서 결론만 보고한다.
```

호출마다 강도를 바꾸려면 서브에이전트 프롬프트 **첫 줄**에 `[[ripple: gpt-5-6-terra@high]]`처럼 적습니다 —
에이전트 이름이든 모델 id든 됩니다. 첫 줄이 아닌 곳의 표식은 그냥 글이라 무시합니다(압축 요약에 인용된
표식이 세션을 엉뚱한 곳으로 보내면 안 되니까요). 라우터가 보낼 곳을 모르는 모델은 어디론가 흘려보내
알 수 없는 에러로 죽게 두지 않고 이름을 대고 거부합니다(`400 ClaudeRipple: no provider declares "…"`).
Claude 모델은 언제나 그대로 통과합니다. 생성을 끄려면 `"cli": { "agentFiles": false }`.

Claude Code의 `WebSearch`는 작은 모델에 별도 요청을 보냅니다. ChatGPT로 라우팅한 구성에서 그 요청만
Anthropic 한도를 쓰지 않게 하려면 `config.json`에서 같은 ChatGPT 프로바이더를 검색 백엔드로 지정합니다:

```jsonc
{ "webSearch": { "provider": "chatgpt", "model": "gpt-5.6-terra" } }
```

명시해야만 켜집니다. `webSearch` 설정이 없으면 Claude Code의 기존 검색 경로는 바뀌지 않습니다.

### Codex 앱과 Codex CLI

```bash
clauderipple codex on     # ~/.codex/config.toml에 "clauderipple" 프로바이더 추가(백업 먼저)
codex --profile clauderipple -m claude-sonnet-5
```

`codex on`은 Codex의 기본 OpenAI 경로(`openai_base_url`)도 ClaudeRipple로 돌립니다. Codex는 ChatGPT 로그인을
그대로 쓰고, GPT 요청은 내용 그대로 ChatGPT로 넘어가되 계정만 ClaudeRipple에 추가한 계정 중에서 골라 끼웁니다.
그래서 계정을 여러 개 추가해 두면 Codex도 한도가 찬 계정에서 다음 계정으로 넘어갑니다. 추가한 계정이 없거나
전부 한도에 걸려 있으면 Codex 자신의 로그인으로 보냅니다. 직접 넣어 둔 `openai_base_url`이 있으면 건드리지 않습니다.
`clauderipple codex off`로 되돌립니다.

Claude 모델이 Codex 모델 목록에 이름 그대로 뜹니다(ClaudeRipple이 Codex 자체 카탈로그 옆에 모델 카탈로그를 씁니다).
Claude는 Claude Code 로그인(실행 중인 Desktop 세션, 터미널 로그인, 또는 ClaudeRipple 자체 로그인 — **프로바이더 →
Claude → Claude 구독 연결…**을 누르면 브라우저가 열리고 터미널은 필요 없습니다. `clauderipple claude-login`과 같습니다)이나
Anthropic API 키로 갑니다. 구독 로그인 재사용은 Anthropic 약관의 적용을 받습니다. 설정한 Anthropic 호환 프로바이더도
같은 방식으로 쓸 수 있습니다.

<p align="center">
  <img src="docs/media/add-provider.png" width="880" alt="프로바이더 추가: ChatGPT 구독, 프리셋, OpenAI 호환 프로바이더">
</p>

## 프로바이더

| 프로바이더 | 종류 | 인증 | 모델 목록 | 비고 |
|---|---|---|---|---|
| ChatGPT 구독 | Codex 백엔드 | 로그인 여러 개, 한도 차면 자동 전환(Codex 로그인도 재사용) | 구독에서 자동으로 읽음(GPT-6 Sol·Luna·Astra, GPT-5.6 …) | 추론 강도 low…max(Luna는 ultra), 프롬프트 캐시 94~99 % |
| OpenRouter | Anthropic 호환 | API 키 | 400+, 자동 검색 | 모델별 추론 강도 지원을 API에서 읽음 |
| DeepSeek, Kimi, Z.ai GLM, MiniMax, Qwen(국제/중국) | Anthropic 호환 | API 키 | 프리셋 | 벤더 공식 문서로 확인 |
| xAI Grok, Mistral, Groq, Together, Fireworks | OpenAI 호환 | API 키 | 자동 검색 | 번역(Chat Completions / Responses) |
| Ollama, LM Studio | OpenAI 호환, 로컬 | 없음 | 자동 검색 | |
| Anthropic | 네이티브 | Claude 로그인(복수 가능) 또는 API 키 | Claude 모델 | Claude Desktop/Code는 선택적 대화 고정 자동 전환, Codex는 로그인 하나 선택 |
| 그 밖의 무엇이든 | 직접 입력 | 자유 | 자동 검색 | Anthropic·OpenAI 호환 엔드포인트라면 무엇이든 |

호환 프로바이더로 가는 요청에서는 Anthropic 전용 필드(서버 측 스레드, 지연 로딩 도구, 컨텍스트 관리, thinking 바인딩)를
걷어 내고 모델별로 추론 강도를 맞추므로, 벤더가 Claude Code의 요청 형태에 400을 내지 않습니다.

## 동작 원리

```
Claude Desktop / claude CLI ──HTTPS_PROXY──▶ ClaudeRipple ──▶ api.anthropic.com   (그대로)
                                               │
                        매핑된 모델 ───────────┼──▶ chatgpt.com/backend-api (Responses ⇄ Messages)
                                               ├──▶ Anthropic 호환 벤더 (+ 호환 계층)
                                               └──▶ OpenAI 호환 벤더 (Messages ⇄ Chat/Responses)
Codex 앱 / CLI ──/v1/responses──▶ ClaudeRipple 입구 ──▶ Claude (내 로그인 또는 API 키) / 벤더
```

- Claude Code CLI는 `~/.claude/settings.json`의 `HTTPS_PROXY`와 `NODE_EXTRA_CA_CERTS`를 읽습니다(Anthropic이 문서화한
  회사 프록시 경로). 그 프로세스만 ClaudeRipple의 로컬 CA를 신뢰합니다. 피커 모드를 켜지 않는 한 OS 키체인은 건드리지 않습니다.
- 피커 모드는 앱 자체의 claude.ai 트래픽을 프록시로 보내고, 앱이 시작할 때 받아 오는 피커 목록에 내 모델을 더합니다.
  끄는 것도 클릭 한 번.
- 라우터는 재시작 때 진행 중인 호출을 끝까지 흘려보내고, 업스트림 실패가 반복되면 스스로 종료해 launchd가 다시 띄우게 하며,
  로그를 순환하고, 요청을 조용히 떨어뜨리는 일이 없습니다.

근거가 달린 세부 설명: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 개인정보

전부 127.0.0.1에서 돕니다. API 키는 `~/.clauderipple/config.json`, 추가한 Claude OAuth 그랜트는
`~/.clauderipple/claude-accounts.json`에만 있고 둘 다 권한은 0600입니다. 관리 API와 로그에는 토큰이나 업스트림
계정 ID를 내보내지 않습니다. 네트워크 목적지는 직접 설정한 프로바이더뿐이며 텔레메트리는 없습니다.

## 상태: 알파

작성자가 매일 쓰고 있지만 아직 어립니다. 거친 부분이 있습니다.

- **Windows 지원은 이제 막 들어갔습니다(2026-09-14).** 설치·설정·라우터·로그인·피커·실제 GPT 호출까지 x64
  실기에서 확인했고, 크래시 복구는 arm64에서 확인했습니다. 창은 아직 Windows 기본 제목 표시줄을 씁니다.
  Windows 빌드는 서명되지 않았습니다(위 설치 항목 참고).
- ChatGPT, OpenRouter, Codex 안의 Claude는 실제 계정으로 검증했습니다. 나머지 프리셋은 벤더 공식 문서를 따릅니다.
- 피커에 추가한 모델은 다음 세션부터 쓸 수 있습니다.
- Claude Code와 Codex는 통신 규약을 자주 바꿉니다. 클라이언트 업데이트가 번역을 깨뜨리면 ClaudeRipple이 따라잡을 때까지
  안 될 수 있습니다. 버그와 로그를 환영합니다.

## 비제휴

ClaudeRipple은 독립 오픈소스 프로젝트입니다. Anthropic이나 OpenAI와 제휴·보증·후원 관계가 없습니다. Claude와 Claude Code는
Anthropic, PBC의 상표입니다. ChatGPT와 Codex는 OpenAI의 상표입니다.

## 라이선스

Copyright (c) 2026 pbj. GPL-3.0 — [LICENSE](LICENSE) 참고. 자유롭게 쓰되, 고쳐서 배포하면 그 소스도 같은 라이선스로 공개해야 합니다.
