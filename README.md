<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center">
  <b>One local proxy for every AI coding client and every model.</b><br>
  Use GPT, DeepSeek, Kimi, Grok and 40+ providers inside <b>Claude Desktop</b> and <b>Claude Code</b> —
  and use Claude from <b>Codex CLI</b> — without turning anything off.
</p>

<p align="center">
  <a href="https://github.com/PBJ-2/clauderipple/releases"><img alt="Release" src="https://img.shields.io/github/v/release/PBJ-2/clauderipple?include_prereleases&label=download"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <img alt="Node" src="https://img.shields.io/badge/runtime-bundled-success">
  <a href="README.ko.md"><img alt="한국어" src="https://img.shields.io/badge/docs-한국어-red"></a>
</p>

<p align="center">
  <img src="docs/media/tour.png" width="880" alt="ClaudeRipple settings tour: status, model mapping, providers, clients, request log">
</p>

<table align="center">
  <tr>
    <td align="center" width="34%"><img src="docs/media/picker-zoom.png" width="300" alt="Real names in the Claude Desktop picker"><br><sub>Real names in the Claude Desktop picker</sub></td>
    <td align="center" width="66%"><img src="docs/media/luna-answer.png" alt="GPT-5.6 Luna answering under its own name, at the effort you chose"><br><sub>GPT-5.6 Luna answering under its own name, at the effort you chose</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/media/subagents.png" alt="Subagents on GPT-5.6 Terra and Sol, named in the background-task panel"><br><sub>Subagents on GPT-5.6 Terra and Sol, named in the background-task panel</sub></td>
  </tr>
</table>

---

## Why

Claude Desktop's own "third-party inference" setting switches the whole app into
another mode: you lose claude.ai chat, Remote Control and cloud sessions. Tools that
replace `ANTHROPIC_BASE_URL` cannot reach the desktop app at all, and the ones that
do translate for ChatGPT often break prompt caching (we measured 12–20% cache hits
on a popular one; eight times the input spend).

ClaudeRipple takes a different path. It is a tiny HTTPS proxy that only the Claude
Code process trusts. Requests for the models you map go to your provider; every
other request goes to Anthropic byte-for-byte. Nothing else changes.

| | ClaudeRipple | opencodex-style proxies | Claude Desktop 3P setting |
|---|---|---|---|
| Claude Desktop Code tab | ✅ | via 3P setting only | ✅ |
| Keeps claude.ai chat, Remote Control, cloud sessions | ✅ | ❌ | ❌ |
| Claude and GPT subscriptions side by side | ✅ | ❌ (all-or-nothing) | ❌ |
| Real model names in the Desktop picker | ✅ | ❌ | partial |
| Prompt cache on translated providers | **94–99%** measured | 12–20% measured | n/a |
| Terminal `claude` CLI, mobile Remote Control | ✅ | ✅ / ❌ | ✅ |
| Codex CLI → Claude and other providers | ✅ | ✅ | ❌ |
| Settings GUI for non-developers | ✅ | partial | ❌ |

## What you get

- **Pick GPT-5.6 Terra, Sol, Luna or GPT-6 Astra in the Claude Desktop picker** —
  under their real names — using your ChatGPT Plus/Pro subscription. Or map any
  Claude name to any model and keep the picker as is.
- **Any provider.** ChatGPT subscription, DeepSeek, Kimi (Moonshot), Z.ai GLM,
  MiniMax, Qwen, OpenRouter (400+ models), xAI Grok, Mistral, Groq, Together,
  Fireworks, Ollama and LM Studio (local) — presets with one-click connection tests
  and model discovery.
- **Every client.** Claude Desktop, the terminal `claude` CLI (`/model gpt-5.6-terra`),
  mobile Remote Control sessions, and **Codex CLI** through a local OpenAI-compatible
  endpoint (`clauderipple codex on`).
- **Correct by construction.** Prompt caching preserved (Anthropic cache breakpoints
  and stable OpenAI prefixes), Claude Code's server-side threads handled, tool calls
  and images round-tripped, reasoning effort clamped to what each model accepts.
- **A real request log.** Who asked, which model answered, tokens in / cached / out,
  latency, status — per request, with a one-hour summary.
- **Subagent name tags.** The background-task panel shows `Terra·high · Review`
  instead of a generic "Agent".
- **Menu-bar app** that carries its own runtime and sets itself up on first launch.
  Signed and notarized.

<p align="center">
  <img src="docs/media/mapping.png" width="880" alt="Model mapping: which model answers for each Claude name, with per-model reasoning effort">
</p>

## Install (macOS)

1. Download `ClaudeRipple-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg`
   (Intel) from [Releases](https://github.com/PBJ-2/clauderipple/releases).
2. Drag ClaudeRipple to Applications and open it. On first launch it offers to set
   itself up: a local certificate, two lines in `~/.claude/settings.json`, and a
   background router that starts at login. No Node install needed.
3. Click the menu-bar icon → **Open ClaudeRipple…** → **Providers** → add ChatGPT
   or paste an API key → **Model mapping**.

Optional, for real names in the Desktop picker: **Clients → Claude Desktop → Model
picker → on**. macOS asks for your login password once to trust the local
certificate (ClaudeRipple never sees it); quit and reopen Claude Desktop.

<details>
<summary>From source (Node 24)</summary>

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install   # certs, settings.json env, launchd agent, end-to-end probe
node packages/cli/src/index.ts ui        # open the local GUI in your browser
```

`uninstall` reverses everything and restores `~/.claude/settings.json` from a backup.
Other commands: `status`, `start`, `stop`, `restart`, `logs -f`, `login`, `logout`,
`claude-login`, `claude-logout`, `picker on|off`, `agent-title on|off`,
`codex on|off`.
</details>

## Clients

### Claude Desktop and Claude Code

Works out of the box after install. Map models on **Model mapping** (auto-saves),
or turn on **picker mode** to see provider models by name in the app's picker.
Subagents follow the same routing; a `[[gpt: sol@xhigh]]` marker in a subagent
prompt overrides the model for that call.

### Terminal `claude`

Same router, same mapping. `/model gpt-5.6-terra` lists the models you added.

### Codex CLI

```bash
clauderipple codex on          # adds a "clauderipple" provider to ~/.codex/config.toml (backup first)
CLAUDERIPPLE_KEY=local codex --profile clauderipple -m claude-sonnet-5 "…"
```

Claude is reached through your Claude Code login (detected from the running
Desktop session, the terminal login, or one created with `clauderipple
claude-login`) or an Anthropic API key. Reusing a subscription login is subject to
Anthropic's terms. Any Anthropic-compatible provider you configured is available
the same way.

<p align="center">
  <img src="docs/media/add-provider.png" width="880" alt="Add provider: ChatGPT subscription, presets, OpenAI-compatible providers">
</p>

## Providers

| Provider | Kind | Auth | Model list | Notes |
|---|---|---|---|---|
| ChatGPT subscription | Codex backend | sign in (or reuse Codex CLI login) | Terra, Sol, Luna, Astra | effort low…max (Luna: ultra), prompt cache 94–99% |
| OpenRouter | Anthropic-compatible | API key | 400+, discovered | per-model effort support read from the API |
| DeepSeek, Kimi, Z.ai GLM, MiniMax, Qwen (intl / cn) | Anthropic-compatible | API key | preset | verified against vendor docs |
| xAI Grok, Mistral, Groq, Together, Fireworks | OpenAI-compatible | API key | discovered | translated (Chat Completions / Responses) |
| Ollama, LM Studio | OpenAI-compatible, local | none | discovered | |
| Anthropic | native | Claude Code login or API key | Claude models | for the Codex ingress |
| Anything else | custom | your choice | discovered | any Anthropic- or OpenAI-compatible endpoint |

Requests to compatible providers are cleaned of Anthropic-only fields
(server-side threads, deferred tools, context management, thinking bindings) and
effort is clamped per model, so vendors do not 400 on Claude Code's request shape.

## How it works

```
Claude Desktop / claude CLI ──HTTPS_PROXY──▶ ClaudeRipple ──▶ api.anthropic.com   (unchanged)
                                               │
                        mapped model ──────────┼──▶ chatgpt.com/backend-api (Responses ⇄ Messages)
                                               ├──▶ Anthropic-compatible vendors (+ compat layer)
                                               └──▶ OpenAI-compatible vendors (Messages ⇄ Chat/Responses)
Codex CLI ──/v1/responses──▶ ClaudeRipple ingress ──▶ Claude (your login or API key) / vendors
```

- The Claude Code CLI reads `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from
  `~/.claude/settings.json` (Anthropic's documented corporate-proxy path). Only that
  process trusts ClaudeRipple's local CA; the OS keychain is untouched unless you
  turn on picker mode.
- Picker mode routes the app's own claude.ai traffic through the proxy and adds
  your models to the picker list the app fetches at start. Off again with one click.
- The router drains in-flight calls on restart, self-exits on repeated upstream
  failures so launchd restarts it, rotates logs, and never drops a request silently.

Details with sources: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Privacy

Everything runs on 127.0.0.1. API keys live in `~/.clauderipple/config.json`
(0600). The only network destinations are the providers you configure. There is no
telemetry.

## Status

Alpha, in daily use by the author. macOS today; Windows is on the
[roadmap](docs/ROADMAP.md). ChatGPT and OpenRouter are verified with live keys;
other presets follow the vendors' official documentation.

## Not affiliated

ClaudeRipple is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are
trademarks of Anthropic, PBC. ChatGPT and Codex are trademarks of OpenAI.

## License

MIT — see [LICENSE](LICENSE).
