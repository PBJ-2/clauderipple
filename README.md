# ClaudeRipple

**Run GPT and other models inside Claude Desktop, without turning Claude off.**

ClaudeRipple is a local proxy for the Claude Desktop app's Code tab. It lets you
pick GPT (via your ChatGPT subscription) or any Anthropic-compatible provider
from the app's own model picker, while every other request keeps going to
Anthropic exactly as before.

- No Developer Mode. No "Configure Third-Party Inference".
- Nothing lost: claude.ai chat, Remote Control, cloud environments, SSH
  sessions, connectors, skills, hooks all keep working.
- No certificate in your system keychain. Only the Claude Code process trusts
  ClaudeRipple's local CA, through `NODE_EXTRA_CA_CERTS`.
- Per-session and per-subagent model choice. Your Claude subscription and your
  GPT subscription work side by side.

> Status: alpha, in daily use by the author. See `docs/ROADMAP.md`.

## Install (macOS)

Requires Node 24 and Claude Desktop.

```bash
git clone https://github.com/pbj/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install      # certs, settings.json env, launchd agent, end-to-end probe
node packages/cli/src/index.ts login        # optional: sign in to ChatGPT for the chatgpt provider
node packages/cli/src/index.ts ui           # open the local GUI (slots, providers, health, logs)
```

`uninstall` reverses everything and restores `~/.claude/settings.json` from a backup.
Other commands: `status`, `start`, `stop`, `restart`, `logs -f`, `logout`.

### Menu-bar app

`packages/app` is an Electron shell around the same local GUI: tray icon with
live health (ok / attention / down), the GUI in a window, restart, ChatGPT
sign-in, logs. Build with `cd packages/app && npm run dist`.

## Providers

- **chatgpt** — your ChatGPT subscription via the Codex backend. Anthropic
  Messages are translated to OpenAI Responses with the prompt cache preserved
  (each turn's input is a byte-stable prefix of the next). Sign in with
  `clauderipple login`, or let it borrow the Codex CLI's login read-only.
- **anthropic-compatible** — any endpoint that speaks Anthropic Messages
  (DeepSeek, Kimi, GLM, MiniMax, a local relay). Host and model rewrite only.

Map picker slots to providers in the GUI: e.g. Opus 4.8 → `gpt-6-astra`,
Sonnet 4.6 → `gpt-5.6-luna`. Subagents can name a model directly
(`model: gpt-5.6-sol@medium`) or put `[[ripple: sol@xhigh]]` at the top of
their prompt.

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
