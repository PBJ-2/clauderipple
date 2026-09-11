# Roadmap

Language: TypeScript, single repository, Node 24. No runtime dependency on any
third-party translator binary.

Status 2026-09-11: M1 done and live on the author's machine (cut over from the
Python prototype). M2 adapter implemented and unit/integration tested; live
streamed answer pending quota reset. M3 in progress (local GUI + Electron tray).

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
