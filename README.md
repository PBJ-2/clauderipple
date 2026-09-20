<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

<p align="center">
  <b>Chat stays Claude. Only Code becomes GPT.</b><br>
  Claude Desktop's own setting for other models switches the <b>whole app</b> — chat, phone Remote
  Control and connectors go with it.<br>ClaudeRipple turns nothing off: you stay signed in to your
  Claude subscription while GPT, DeepSeek, Kimi, Grok<br>or 400+ other models answer in the
  <b>Code tab</b>. Claude inside the <b>Codex app</b> and <b>Codex CLI</b> too.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clauderipple"><img alt="npm" src="https://img.shields.io/npm/v/clauderipple?label=npm"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-orange">
  <a href="LICENSE"><img alt="GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-arm64%20%7C%20x64-0078D4">
  <img alt="Node" src="https://img.shields.io/badge/node-24%2B-success">
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

## 1P, not 3P: the difference this whole project exists for

Claude Desktop already ships an official way to use other models — the **inference
gateway** setting, what the app calls third-party or **3P** mode. Turning it on is
not a per-session choice. It switches the **whole app** into a different deployment
mode at launch, and that mode is a different product:

- The window stops loading `claude.ai` and loads a local bundle instead. claude.ai
  `/api/` and `/v1/` calls answer `custom_3p_not_available` 503.
- "Chat" is no longer claude.ai chat. It is a Claude Code local-agent session.
- Remote Control and side sessions are switched off outright
  (`shouldEnableSessionsBridge()` returns false).
- Anthropic's own claude.ai connectors, Claude Design, mobile continuity and chat
  search go with it.

There is no middle setting. "Chat on Claude, Code on the gateway" is impossible for
anyone, because 1P mode routes nothing through the gateway at all. (All of this is
read out of the app's own bundle; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2.)

**ClaudeRipple never touches that setting.** The app stays signed in to your Claude
subscription in 1P mode, and another model answers in the Code tab and its subagents
— under its real name in the model picker, at the reasoning effort you chose. You do
not trade your Claude account for a GPT one. You keep both, in one app.

Three things follow from staying in 1P, and no gateway-based tool can offer any of them:

- **Code from your phone, on GPT.** Remote Control is off in 3P. It is on here, so you
  can pick a model and send a task from a phone and watch the commits land.
- **Connectors alive while another model works.** 3P stubs claude.ai calls, which takes
  Anthropic's own connectors with them. Read a Google Drive doc and have GPT write the code.
- **Cloud and side sessions.** Gone in 3P. Untouched here.

If you pay for Claude, 3P is not an option — it throws away the half of the
subscription you are paying for. This is the only way to keep it and still choose
the model.

## FAQ

### Can I use GPT in the Claude Desktop app?

Yes. Install ClaudeRipple, map a Claude model name to a GPT model, and the Code tab
answers with GPT under its real name in the model picker. The app itself is not
modified and not switched into any other mode.

### How do I use GPT in Claude Code?

The same install covers the terminal `claude` CLI. ClaudeRipple is a local proxy that
Claude Code is pointed at through two lines in `~/.claude/settings.json`, so your
skills, hooks, MCP servers, `CLAUDE.md` and subagents keep working while another model
answers.

### Do I have to turn on Claude Desktop's "third-party inference" (gateway) setting?

No — and you should not. That setting switches the whole app into 3P mode, which stops
loading claude.ai, replaces chat with a local-agent session and turns Remote Control
off. ClaudeRipple never touches it.

### Will I lose claude.ai chat, Remote Control or my connectors?

No. The app stays signed in to your Claude subscription, so chat, phone Remote Control,
cloud sessions and Anthropic's own connectors keep working. That is the whole point of
staying in 1P.

### Can I still use Claude itself?

Yes. Model mapping is per model name: leave a name mapped to Claude and it answers as
Claude. Most people map one or two names to GPT and leave the rest alone.

### Do I need an OpenAI API key?

No. A ChatGPT Plus or Pro subscription works — you sign in from the app and no API key
is involved. API keys are for the other providers (DeepSeek, Kimi, GLM, OpenRouter and
anything else with an Anthropic- or OpenAI-compatible endpoint).

### Which models can I use?

GPT through a ChatGPT subscription, and DeepSeek, Kimi, GLM, Grok, Qwen and 400+ more
through OpenRouter or a direct API key. Claude models keep working as they are.

### Does it work on Windows?

Yes, on Windows and macOS, arm64 and x64. Install, dashboard, restart and uninstall are
measured on Windows 11 arm64; the x64 runtime is measured under emulation.

### Is my code sent anywhere else?

No. The proxy runs on your own machine. Requests go to the provider you configured and
nowhere else, and credentials stay in your home directory. See [Privacy](#privacy).

## One tool instead of four

Similar tools are built for the terminal. They let the Claude Code CLI or Codex CLI
use other models, but they cannot reach the Claude **desktop app**, and the moment
you switch models you lose the Claude-subscription side (claude.ai chat, Remote
Control, cloud sessions). ClaudeRipple covers the desktop app, the terminal and
Codex from one menu-bar app, runs both subscriptions side by side, and keeps the
Claude Code harness intact: your skills, hooks, MCP servers, `CLAUDE.md`, subagents
and claude.ai connectors keep working while another model does the thinking.

| | ClaudeRipple | opencodex / openclaude | claude-code-router | Claude Desktop gateway (3P) mode |
|---|---|---|---|---|
| Claude **Desktop** Code tab **without** gateway (3P) mode | ✅ | ❌ ¹ | ❌ | ❌ by definition |
| Keeps claude.ai chat, Remote Control, cloud sessions, connectors | ✅ | ❌ | ❌ | ❌ |
| Claude and GPT subscriptions side by side | ✅ | ❌ all-or-nothing | ❌ | ❌ |
| Real model names in the Desktop picker | ✅ | ❌ | ❌ | partial |
| Terminal `claude` CLI | ✅ | ✅ | ✅ | ✅ |
| Codex **app** and Codex CLI → Claude | ✅ | ✅ | ❌ | ❌ |
| Prompt cache on translated providers | **94–99 %** measured | not measured | varies | n/a |
| Subagents named by real model in the task panel | ✅ | ❌ | ❌ | ❌ |
| Settings GUI, no terminal needed | ✅ | ❌ | ❌ | ❌ |
| Signed, notarized app with its own runtime | ✅ | ❌ | ❌ | – |

¹ opencodex's README shows Claude Desktop in a demo but publishes no setup steps for it,
in the repository or on its documentation site (checked 2026-09-16). The only public way
into the desktop app is the official gateway setting — the last column.

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

**macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.ps1 | iex
```

That is the whole prerequisite list. The script uses a Node 24+ you already have, and
downloads the official build into `~/.clauderipple/runtime` when you have none,
verifying it against the checksum nodejs.org publishes. Then it sets ClaudeRipple up:
a local certificate, two lines in `~/.claude/settings.json`, and a background router
that starts with your computer. No administrator rights, no password.

With Node already installed you can skip the script:

```sh
npm install -g clauderipple
clauderipple install
```

Then open the dashboard and add a provider:

```sh
clauderipple ui
```

**Providers** → add ChatGPT or paste an API key → **Model mapping**.

**The menu-bar / tray app** is optional. It shows the router's state and opens the
dashboard in a click:

```sh
clauderipple tray
```

It runs on Electron, which is about 270MB and is therefore not installed by default.
`clauderipple tray --install` fetches it once; everything else works without it.

**Updating.**

```sh
npm install -g clauderipple@latest
clauderipple restart
```

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

**You do not have to build an agent harness for this.** Point the subagent slot at
a routed model and every subagent runs on it — no agent file, nothing else:

```jsonc
// Settings → CLI models, or "cli": { "models": { … } } in the config
{ "subagent": "gpt-5.6-terra" }   // → CLAUDE_CODE_SUBAGENT_MODEL
```

**Every model you tick is also a named subagent.** The router writes
`~/.claude/agents/<name>.md` for each model exactly one provider carries
(`gpt-5.6-terra` → `gpt-5-6-terra`, `deepseek-v4.1-flash` → `deepseek-v4-1-flash`),
so "have DeepSeek do it" needs nothing beyond ticking the model: the Agent tool
lists it, `subagent_type: "deepseek-v4-1-flash"` runs it, and the task panel
names it. Untick the model and its file goes away. The router only ever touches
the files it wrote (recorded in `generated-agents.json`); an agent file you wrote
yourself under the same name wins and is left alone, so a custom brief is still
just Claude Code's own agent file with a `model:` the router knows:

```markdown
---
name: reviewer
description: Independent review on GPT-5.6 Sol.
model: gpt-5.6-sol@medium
---
You are the reviewer for this session. Verify the change yourself and report
the conclusion only.
```

Per-call effort goes on the **first line** of the subagent prompt:
`[[ripple: gpt-5-6-terra@high]]` — any agent name or model id works there. A
marker anywhere else is prose and is ignored (a compaction summary that quotes
one must not re-route the session). A model the router cannot place is refused
by name (`400 ClaudeRipple: no provider declares "…"`) instead of being sent on
to fail somewhere less legible; native Claude models always pass through.
Set `"cli": { "agentFiles": false }` to turn generation off.

Claude Code runs `WebSearch` as a separate small-model request. To keep a
ChatGPT-routed setup from spending Anthropic quota for that request, select the
same ChatGPT provider as the search backend in `config.json`:

```jsonc
{ "webSearch": { "provider": "chatgpt", "model": "gpt-5.6-terra" } }
```

This is opt-in. With no `webSearch` setting, Claude Code's existing search path
is unchanged.

### Codex app and Codex CLI

```bash
clauderipple codex on     # adds a "clauderipple" provider to ~/.codex/config.toml (backup first)
codex --profile clauderipple -m claude-sonnet-5
```

Claude models show up in Codex's model list under their names (ClaudeRipple writes
a model catalog next to Codex's own). Claude is reached through your Claude Code
login (detected from the running Desktop session, the terminal login, or a
sign-in of ClaudeRipple's own: **Providers → Claude → Connect Claude
subscription…** opens the browser, no terminal needed; the same as
`clauderipple claude-login`) or an Anthropic API key. Reusing a
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

- **Windows support is new (2026-09-14).** Install, setup, the router, signing
  in, the picker and a live GPT call are verified on x64 hardware; crash recovery
  on arm64. The window still has the stock Windows title bar. Windows builds are
  unsigned; see the note under Install.
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
