# ClaudeRipple

**Run GPT and other models inside Claude Desktop, without turning Claude off.**

ClaudeRipple is a local proxy for Claude Code. It lets you pick GPT (via your
ChatGPT subscription), any Anthropic-compatible provider (DeepSeek, Kimi, GLM,
MiniMax, Qwen, OpenRouter…), or OpenAI-compatible provider (xAI Grok, Mistral,
Groq, Together, Fireworks, Ollama, LM Studio) from Claude Desktop's own model picker, while every
other request keeps going to Anthropic exactly as before.

It works everywhere Claude Code runs, because it plugs into the settings file
Claude Code reads: the **Claude Desktop Code tab**, the **terminal `claude` CLI**
(`/model gpt-5.6-terra`), and **mobile Remote Control** sessions. Only the "real
names in the picker" feature is desktop-only.

- No Developer Mode. No "Configure Third-Party Inference".
- Nothing lost: claude.ai chat, Remote Control, cloud environments, SSH
  sessions, connectors, skills, hooks all keep working.
- No certificate in your system keychain. Only the Claude Code process trusts
  ClaudeRipple's local CA, through `NODE_EXTRA_CA_CERTS`. (Picker mode adds the
  CA to your *login* keychain, with your consent, and can be turned off again.)
- Per-session and per-subagent model choice. Your Claude subscription and your
  GPT subscription work side by side.
- Prompt caching preserved on translated providers (94–99% cache hit measured
  on multi-turn sessions).

> Status: alpha, in daily use by the author. macOS today; see `docs/RELEASE.md`
> for what Windows still needs.

## Install (macOS)

### Menu-bar app (recommended)

Download `ClaudeRipple-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg`
(Intel) from the Releases page, drag ClaudeRipple to Applications, open it. On
first launch it offers to set itself up: local certificate, the two lines in
`~/.claude/settings.json`, and a background router that starts at login. The app
carries its own runtime; you do not need Node installed.

The menu-bar icon shows health (drop + rings = ok, one ring = attention, hollow
drop = router down). "Open ClaudeRipple…" opens the settings window:
providers, model mapping, picker, logs.

### From source

Requires Node 24 and Claude Desktop.

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install      # certs, settings.json env, launchd agent, end-to-end probe
node packages/cli/src/index.ts ui           # open the local GUI in your browser
```

`uninstall` reverses everything and restores `~/.claude/settings.json` from a backup.
Other commands: `status`, `start`, `stop`, `restart`, `logs -f`, `login`, `logout`,
`claude-login`, `claude-logout`, `picker on|off`, `agent-title on|off`.

## Providers

- **chatgpt** — your ChatGPT subscription via the Codex backend. Anthropic
  Messages are translated to OpenAI Responses with the prompt cache preserved
  (each turn's input is a byte-stable prefix of the next). Sign in with
  `clauderipple login`, or let it borrow the Codex CLI's login read-only.
- **anthropic-compatible** — any endpoint that speaks Anthropic Messages
  (DeepSeek, Kimi, GLM, MiniMax, a local relay). Host and model rewrite only.
- **openai-compatible** — Chat Completions (default) or stateless Responses APIs
  translated from Anthropic Messages: xAI Grok, Mistral, Groq, Together, Fireworks,
  Ollama, LM Studio, and compatible native OpenRouter-style endpoints. Native vendor
  cached-token fields are recorded when provided; cache availability remains vendor- and model-specific.

Map picker slots to providers in the GUI: e.g. Opus 4.8 → `gpt-6-astra`,
Sonnet 4.6 → `gpt-5.6-luna`. Subagents can name a model directly
(`model: gpt-5.6-sol@medium`) or put `[[ripple: sol@xhigh]]` at the top of
their prompt.

## Use Claude or other providers from Codex CLI

ClaudeRipple also exposes a localhost OpenAI-compatible ingress for Codex and
other OpenAI Responses/Chat Completions clients. Add either an
`anthropic-compatible` provider (for example OpenRouter's Anthropic endpoint)
or a native Anthropic provider in ClaudeRipple's config:

```json
"anthropic": { "type": "anthropic", "auth": "api-key", "apiKey": "…" }
```

For Claude Code's existing login instead, use
`{ "type": "anthropic", "auth": "claude-code" }`. ClaudeRipple prefers a
recent in-memory header snapshot from an active Claude Code session, then
`CLAUDE_CODE_OAUTH_TOKEN`, Claude Code's Keychain/file login, and finally its
own setup-token file. It never refreshes Claude Code's credential and is subject
to Anthropic's terms. If no usable login exists, run `clauderipple claude-login`:
it opens Claude Code's browser authorization flow and saves the resulting
long-lived token privately as `~/.clauderipple/claude-auth.json` (mode 0600).
Run `clauderipple claude-logout` to remove only that file.

Then run `clauderipple codex on`. It backs up and writes only ClaudeRipple's
provider block in `$CODEX_HOME/config.toml` and a selection profile at
`$CODEX_HOME/clauderipple.config.toml`; it does not change your normal Codex
provider. Start a session with:

```bash
CLAUDERIPPLE_KEY=local codex --profile clauderipple -m claude-sonnet-5 "say ok"
```

The local URL is `http://127.0.0.1:<listen.openaiPort or listen.port+2>/v1`.
Supported endpoints are `/v1/responses`, `/v1/chat/completions`, and
`/v1/models`. The ingress is stateless: `previous_response_id` intentionally
returns a clear 400 rather than dropping prior context. See architecture §4b
for the request/cache behavior and OAuth compatibility evidence.

## How it works

Claude Desktop launches the Claude Code CLI for every Code-tab session. The CLI
honors `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from `~/.claude/settings.json`,
a path Anthropic documents for enterprise proxies. ClaudeRipple listens on
localhost, terminates TLS for `api.anthropic.com` with its own CA, and looks at
one field of each request: `model`.

```
Claude Desktop ──▶ Claude Code CLI ──HTTPS_PROXY──▶ ClaudeRipple
                                                     │
                       model is a mapped alias ──────┼──▶ provider adapter (GPT, ...)
                       anything else ────────────────┴──▶ api.anthropic.com, byte for byte
```

Everything that is not a mapped model is forwarded untouched, including OAuth,
session bootstrap, remote-control worker traffic and telemetry.

## Why not the official third-party inference setting?

Claude Desktop does have a gateway setting under Developer Mode. Turning it on
switches the whole app into a third-party deployment mode: claude.ai chat is
replaced by a local bundle, Remote Control and cloud environments are disabled,
and the gateway receives all traffic, so you lose Claude itself inside the app.
Every existing "use other models in Claude Desktop" tool goes through that
setting. ClaudeRipple does not.

## Not affiliated

ClaudeRipple is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Anthropic or OpenAI. "Claude" and "Claude Code" are
trademarks of Anthropic, PBC. "ChatGPT" and "GPT" are trademarks of OpenAI.

## License

MIT. See `LICENSE`.
