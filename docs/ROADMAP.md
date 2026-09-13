# Roadmap

Language: TypeScript, single repository, Node 24. No runtime dependency on any
third-party translator binary.

Status 2026-09-13: M1–M3 done and released (signed, notarized macOS app 0.1.0
built; not yet published). M4 in progress: ClaudeRipple becomes a universal
local proxy — OpenAI-style clients (Codex CLI first) can use Claude and
Anthropic-compatible providers through it, and Claude Code can use
OpenAI-only providers (Grok, Mistral, Groq, Ollama…). M5 = Windows.

## M1 — Router + installer (replaces the Python prototype)

- `packages/router`: CONNECT proxy, TLS termination for `api.anthropic.com`,
  per-request `model` routing, byte-exact passthrough, effort clamp, hot-reloaded
  config, structured logs with rotation.
- Reliability built in: strong refs to in-flight connections, request/response
  accounting, consecutive-upstream-failure self-exit, supervisor (launchd on
  macOS) that restarts the whole chain.
- `packages/cli`: `clauderipple install` (generate CA + leaf, write the two
  `settings.json` env keys, register supervisor), `status`, `logs`, `uninstall`
  (restores settings.json exactly).
- Acceptance: run on a second port alongside the Python router; A/B the same
  sessions for one day; zero vanished requests; remote-control workers survive
  a forced upstream DNS failure (self-exit + restart within 5s).

## M2 — Providers

- Adapter interface: `{ match(model), rewrite(request), upstream }`.
- Anthropic-compatible adapter (host + model rewrite). Presets verified per
  provider before inclusion.
- ChatGPT subscription adapter: OAuth PKCE login, Anthropic Messages ⇄ OpenAI
  Responses translation, SSE streaming, tool-call round trip, prompt-cache
  preservation, quota reporting in Anthropic's shape.
- Acceptance: ≥90% cache hit on a multi-turn tool session; tool round trip;
  compaction succeeds at the model's real window; effort levels pass through.

## M3 — GUI

- The router serves a local GUI (`packages/ui`) and an admin API on
  127.0.0.1:(port+1): slot mapping (which picker entry → which provider model),
  providers, chain health, request log, quota, about.
- `packages/app`: Electron menu-bar shell that hosts that GUI in a window and
  shows health in the tray (ok / attention / down), with restart, login, logs.
- Ships the installer inside; the CLI remains for headless use.

## Later

- Keychain mode: system-trusted CA + whole-app proxy to inject real model names
  into the picker (`model_selector_config`).
- Windows support (Claude Desktop on Windows honors the same CLI env; verify).
- Sponsor slots in README once traction exists.

## M4 — Universal proxy (both directions)

- OpenAI-compatible **ingress** (`packages/router/src/ingress`): `/v1/responses`
  and `/v1/chat/completions` on a local plain-HTTP port, translated to Anthropic
  Messages, routed through the same model mapping. `clauderipple codex on`
  points the Codex CLI at it. API keys only (no reuse of Claude subscription
  OAuth from other clients).
- **openai-compatible provider type** (`packages/router/src/providers/openai`):
  Anthropic Messages → Chat Completions / Responses, streaming and tools, cache
  fields mapped when the vendor reports them. Presets: xAI Grok, Mistral, Groq,
  Together, Fireworks, Ollama, LM Studio.
- Acceptance: Codex CLI completes a tool-using session against Claude via the
  ingress; Claude Code completes a tool-using session against Grok or a local
  Ollama model; the request log shows both with usage.

## M5 — Windows

- Certificate generation without OpenSSL (pure Node), a Task Scheduler /
  service supervisor, `certutil` for picker-mode trust, the app's
  `%LOCALAPPDATA%\Claude-3p\configLibrary` path. Electron build for win-x64.
