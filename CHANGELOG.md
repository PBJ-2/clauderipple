# Changelog

## 0.1.0 — 2026-09-13 (first public alpha)

- Local HTTPS proxy for Claude Code: model mapping (Claude name → any provider
  model), per-request effort, graceful drain on restart, structured request log.
- ChatGPT subscription provider (Codex backend) with prompt-cache preservation
  (94–99% cache hit on multi-turn sessions), server-side thread fallback, and
  orphan tool-result handling.
- Anthropic-compatible providers with presets: DeepSeek, Kimi (Moonshot), Z.ai
  (GLM), MiniMax, Qwen (DashScope intl/cn), OpenRouter. Connection test and
  model discovery from the GUI; compatibility layer that strips Anthropic-only
  request features.
- Picker mode: your provider models appear under their real names in Claude
  Desktop's model picker (login-keychain trust, app config-library proxy).
- Subagent name tags (real model and effort in the background-task panel) via a
  Claude Code hook.
- Local GUI (Korean/English): status, model mapping with auto-save, providers,
  request log; menu-bar app that carries its own runtime and sets itself up on
  first launch. Signed and notarized macOS builds (arm64, x64).
- Works with the Claude Desktop Code tab, the terminal CLI, and mobile Remote
  Control sessions.

Known limits: macOS only; presets other than ChatGPT and OpenRouter are verified
against vendor docs, not with live keys; a model added to the picker is usable
from the next session.
