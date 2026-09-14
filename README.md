<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<p align="center">
  <b>Every model, in every AI coding client, without giving anything up.</b><br>
  GPT, DeepSeek, Kimi, Grok and 400+ models inside <b>Claude Desktop</b> and <b>Claude Code</b>.<br>
  Claude inside the <b>Codex app</b> and <b>Codex CLI</b>. One local proxy, one menu-bar app.
</p>

<p align="center">
  <a href="https://github.com/PBJ-2/clauderipple/releases"><img alt="Release" src="https://img.shields.io/github/v/release/PBJ-2/clauderipple?include_prereleases&label=download"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-orange">
  <a href="LICENSE"><img alt="GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-arm64%20%7C%20x64-0078D4">
  <img alt="Node" src="https://img.shields.io/badge/runtime-bundled-success">
  <a href="README.ko.md"><img alt="한국어" src="https://img.shields.io/badge/docs-한국어-red"></a>
</p>

<p align="center">
  <img src="docs/media/tour.png" width="880" alt="ClaudeRipple settings tour: status, model mapping, providers, clients, request log">
</p>

<table align="center">
  <tr>
    <td align="center" width="34%"><img src="docs/media/picker-zoom.png" width="300" alt="Real names in the Claude Desktop picker"><br><sub>GPT models under their real names in the Claude Desktop picker</sub></td>
    <td align="center" width="66%"><img src="docs/media/luna-answer.png" alt="GPT-5.6 Luna answering in the Claude Desktop Code tab"><br><sub>GPT-5.6 Luna answering in the Code tab, at the effort you chose</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/media/subagents.png" alt="Subagents on GPT-5.6 Terra and Sol, named in the background-task panel"><br><sub>Subagents on GPT-5.6 Terra and Sol, named in the background-task panel</sub></td>
  </tr>
</table>

---

## One tool instead of four

Similar tools are built for the terminal. They let the Claude Code CLI or Codex CLI
use other models, but they cannot reach the Claude **desktop app**, and the moment
you switch models you lose the Claude-subscription side (claude.ai chat, Remote
Control, cloud sessions). ClaudeRipple covers the desktop app, the terminal and
Codex from one menu-bar app, runs both subscriptions side by side, and keeps the
Claude Code harness intact: your skills, hooks, MCP servers, `CLAUDE.md`, subagents
and claude.ai connectors keep working while another model does the thinking.

| | ClaudeRipple | opencodex / openclaude | claude-code-router | Claude Desktop "3P" setting |
|---|---|---|---|---|
| Claude **Desktop** Code tab | ✅ | ❌ | ❌ | ✅ |
| Keeps claude.ai chat, Remote Control, cloud sessions | ✅ | ❌ | ❌ | ❌ |
| Claude and GPT subscriptions side by side | ✅ | ❌ all-or-nothing | ❌ | ❌ |
| Real model names in the Desktop picker | ✅ | ❌ | ❌ | partial |
| Terminal `claude` CLI | ✅ | ✅ | ✅ | ✅ |
| Codex **app** and Codex CLI → Claude | ✅ | ✅ | ❌ | ❌ |
| Prompt cache on translated providers | **94–99 %** measured | 12–20 % measured | varies | n/a |
| Subagents named by real model in the task panel | ✅ | ❌ | ❌ | ❌ |
| Settings GUI, no terminal needed | ✅ | ❌ | ❌ | ❌ |
| Signed, notarized app with its own runtime | ✅ | ❌ | ❌ | – |

The desktop app's own "third-party inference" setting flips the whole app into another
mode: you lose claude.ai chat, Remote Control and cloud sessions. Tools that replace
`ANTHROPIC_BASE_URL` never reach the desktop app at all. ClaudeRipple instead is a
tiny HTTPS proxy that only the Claude Code process trusts: requests for the models
you map go to your provider, everything else goes to Anthropic byte for byte.

## What you get

- **Any model in Claude Desktop and Claude Code.** GPT-5.6 Terra / Sol / Luna and
  GPT-6 Astra through your ChatGPT Plus/Pro subscription, or DeepSeek, Kimi, GLM,
  MiniMax, Qwen, Grok, Mistral, Groq, Together, Fireworks, OpenRouter (400+ models)
  and local Ollama / LM Studio. Under their real names in the picker, or mapped onto
  a Claude name.
- **Claude in the Codex app and Codex CLI.** A local OpenAI-compatible endpoint that
  Codex treats as a provider; Claude models appear in Codex's own model list. Uses
  your Claude Code login or an Anthropic API key.
- **The full Claude Code harness, untouched.** Skills, hooks, MCP, `CLAUDE.md`,
  subagents, plan mode, Remote Control on your phone: nothing is turned off.
- **Correct by construction.** Prompt caching preserved (Anthropic cache breakpoints
  and stable OpenAI prefixes), Claude Code's server-side threads handled, tool calls
  and images round-tripped, reasoning effort clamped to what each model accepts,
  Anthropic-only request fields stripped for compatible vendors.
- **A real request log.** Who asked, which model answered, tokens in / cached / out,
  latency, status, per request, with a one-hour summary.
- **Subagent name tags.** The background-task panel shows `Terra·high · Review`
  instead of a generic "Agent".
- **Made for people who don't want a terminal.** Provider presets with one-click
  connection tests and model discovery, drop-down model mapping, auto-save, Korean
  and English UI. A menu-bar app that carries its own runtime and sets itself up on
  first launch. Signed and notarized.

<p align="center">
  <img src="docs/media/mapping.png" width="880" alt="Model mapping: which model answers for each Claude name, with per-model reasoning effort">
</p>

## Install

*No release yet: the first builds are being finished. Until then, install from
source below — it is the same code.*

**macOS.** Download `ClaudeRipple-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg`
(Intel) from [Releases](https://github.com/PBJ-2/clauderipple/releases), drag
ClaudeRipple to Applications and open it.

**Windows.** Download `ClaudeRipple-<version>-win-x64.zip` (or `-arm64.zip`),
unpack it anywhere, and run `ClaudeRipple.exe`. There is also an installer
(`ClaudeRipple-Setup-…exe`) but it is **not verified yet** — see the note below.

> **Windows shows "Windows protected your PC".** The build is not code-signed —
> a certificate costs $219–685/year and needs a hardware token, which this project
> does not spend money on. Click **More info → Run anyway**. If you would rather
> not, build from source; the result is identical.

> **The installer is unverified.** On Windows 11 arm64 it installs everything
> *except* the executables and reports success anyway, so the app will not start.
> The zip does not have this problem. If you try the installer on x64, please
> [tell us what happened](https://github.com/PBJ-2/clauderipple/issues).

On first launch the app offers to set itself up: a local certificate, two lines in
`~/.claude/settings.json`, and a background router that starts at login. No Node
install needed. Then: tray icon → **Open ClaudeRipple…** → **Providers** → add
ChatGPT or paste an API key → **Model mapping**.

Optional, for real names in the Desktop picker: **Clients → Claude Desktop → Model
picker → on**, then quit and reopen Claude Desktop. To trust the local certificate
for your user only, macOS asks for your login password and Windows shows a
confirmation dialog with the fingerprint — ClaudeRipple never sees a password, and
neither platform needs administrator rights.

> **Closing Claude Desktop's window is not enough.** It keeps running, and the next
> launch reuses it without reading the new setting. Quit it properly (macOS: ⌘Q;
> Windows: the tray icon, or Task Manager) or the picker will silently not change.

<details>
<summary>From source (Node 24)</summary>

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install   # certs, settings.json env, supervisor (launchd / Task Scheduler), end-to-end probe
node packages/cli/src/index.ts ui        # open the local GUI in your browser
```

`uninstall` reverses everything and restores `~/.claude/settings.json` from a backup.
Other commands: `status`, `start`, `stop`, `restart`, `logs -f`, `login`, `logout`,
`claude-login`, `claude-logout`, `picker on|off`, `agent-title on|off`,
`codex on|off`.
</details>

## Clients

### Claude Desktop

Works out of the box after install. Map models on **Model mapping** (auto-saves),
or turn on **picker mode** to see provider models by name in the app's own picker.
Effort chosen in the app is passed through; unsupported levels are clamped.

### Claude Code (terminal, Remote Control, subagents)

Same router, same mapping. `/model gpt-5.6-terra` lists the models you added.
Subagents follow the routing; a `[[gpt: sol@xhigh]]` marker in a subagent prompt
overrides the model for that call, and the task panel shows the real model name.

### Codex app and Codex CLI

```bash
clauderipple codex on     # adds a "clauderipple" provider to ~/.codex/config.toml (backup first)
codex --profile clauderipple -m claude-sonnet-5
```

Claude models show up in Codex's model list under their names (ClaudeRipple writes
a model catalog next to Codex's own). Claude is reached through your Claude Code
login (detected from the running Desktop session, the terminal login, or one
created with `clauderipple claude-login`) or an Anthropic API key. Reusing a
subscription login is subject to Anthropic's terms. Any Anthropic-compatible
provider you configured is available the same way.

<p align="center">
  <img src="docs/media/add-provider.png" width="880" alt="Add provider: ChatGPT subscription, presets, OpenAI-compatible providers">
</p>

## Providers

| Provider | Kind | Auth | Model list | Notes |
|---|---|---|---|---|
| ChatGPT subscription | Codex backend | sign in (or reuse Codex login) | Terra, Sol, Luna, Astra | effort low…max (Luna: ultra), prompt cache 94–99 % |
| OpenRouter | Anthropic-compatible | API key | 400+, discovered | per-model effort support read from the API |
| DeepSeek, Kimi, Z.ai GLM, MiniMax, Qwen (intl / cn) | Anthropic-compatible | API key | preset | verified against vendor docs |
| xAI Grok, Mistral, Groq, Together, Fireworks | OpenAI-compatible | API key | discovered | translated (Chat Completions / Responses) |
| Ollama, LM Studio | OpenAI-compatible, local | none | discovered | |
| Anthropic | native | Claude Code login or API key | Claude models | for the Codex side |
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
Codex app / CLI ──/v1/responses──▶ ClaudeRipple ingress ──▶ Claude (your login or API key) / vendors
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

## Status: alpha

In daily use by the author, but young. Expect rough edges:

- **Windows support is new (2026-09-14).** Every feature was verified end to end on
  Windows 11 arm64 — picker, certificate trust, autostart and crash recovery, real
  model calls. The x64 build is the same code but has not been run on x64 hardware
  yet. Windows builds are unsigned; see the note under Install.
- ChatGPT, OpenRouter and Claude-in-Codex are verified with live accounts; the
  other presets follow the vendors' official documentation.
- A model added to the picker is usable from the next session.
- Claude Code and Codex change their wire protocols often; a client update can
  break a translation until ClaudeRipple catches up. Bugs and logs welcome.

## Not affiliated

ClaudeRipple is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Anthropic or OpenAI. Claude and Claude Code are
trademarks of Anthropic, PBC. ChatGPT and Codex are trademarks of OpenAI.

## License

Copyright (c) 2026 pbj. GPL-3.0 — see [LICENSE](LICENSE). Use it freely; if you distribute a modified
version, ship its source under the same license.
