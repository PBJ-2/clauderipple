# Changelog

## 0.1.2 — unreleased

Why 0.1.1 did not help the Windows install that reported the 0.1.1 bugs: the
fixes were in the files, but the router that kept answering was the old
process. Nothing restarted it, and nothing could tell.

### Changed

- **Distribution is npm.** `npm install -g clauderipple && clauderipple install`.
  There is no per-platform build to make, nothing to sign, nothing to notarize and
  no Windows VM in the loop: one `npm publish` serves both platforms, and the
  arm64 Windows installer bug cannot reach anyone through this path. The cost is
  that the user needs Node 24. The published package is JavaScript, because Node
  refuses to strip types under `node_modules`; the electron-builder path is still
  there for a standalone app but is no longer required for a release.
- **The tray is a command and an optional dependency.** `clauderipple tray` starts
  the menu-bar / tray app using the Electron that npm installed for this platform.
  Without it every other command still works.

### Added

- **Claude subscription sign-in from the app.** "Connect Claude subscription…"
  in the GUI (and `clauderipple claude-login`) now runs ClaudeRipple's own
  browser sign-in: the same OAuth flow with PKCE that Claude Code uses, with the
  code returning to a loopback listener on port 54545 or, when that port is
  taken, pasted from Anthropic's page. No terminal needed. The grant is stored
  in `~/.clauderipple/claude-auth.json` (mode 0600) and refreshed automatically
  before it expires; a failed refresh becomes a clear 401 instead of a dead
  token. `--setup-token` keeps the previous terminal-only path. Tray →
  "Connect Claude subscription" runs the same flow.
- **Readiness, not only liveness.** `/api/status.readiness` and `GET /readyz`
  (200, or 503 with `retry-after`) name what stands between a request and a
  model: Claude Code not pointed at ClaudeRipple, Anthropic unreachable, picker
  mode without certificate trust or the app proxy entry, a provider host that
  does not answer. The tray shows the list next to "Connected".
- **The stored sign-in is reported separately from the one in use.** A live
  Claude Desktop session outranks ClaudeRipple's own credential, so the provider
  screen now names both: the source a request would use, and, on its own line,
  whether a ClaudeRipple sign-in is stored and waiting behind it. Without this a
  successful sign-in changed nothing on screen.
- **A model removed from a provider leaves the app picker.** Unticking a model
  rewrote the provider but left its entry in `cli.extraModels` and its `direct`
  rule behind, and the next save read that entry back as a selection. Since the
  tick list is built from the providers, such an entry had no checkbox and could
  never be removed; duplicated ids appeared twice in the picker. The selection is
  now rebuilt from what the providers actually offer, deduplicated by model id,
  and a direct rule that served only a removed model goes with it. A prefix rule
  that is not a model id, such as the legacy `gpt-` one, is kept.
- **Every provider can tell the model what it is.** The identity line and the
  system-prompt addendum were ChatGPT-only, so a mapped DeepSeek read Claude
  Code's own prompt and answered that it was Claude. Anthropic-compatible and
  OpenAI-compatible providers now carry the same two settings, on by default,
  and the GUI offers them under Advanced for every provider.
- **HTML error pages are called out.** A provider that answers with a web page
  (a bare vendor domain, a login wall) is logged as "HTML page … not an API"
  instead of a quoted markup fragment.

### Fixed

- **An update now replaces the running router.** Installing a new version only
  replaces files; the supervisor had started the router at logon from the old
  ones, and `start` leaves a running router alone, so the old code kept serving
  after every update. A zip unpacked into a new folder was worse: the
  supervisor and `paths.json` still named the old folder, so even a restart
  brought the old code back. The tray app now compares the running router's
  version and files with its own once per launch; if they differ it re-runs
  `install` (only when this installation's files are not the recorded ones) and
  restarts the router, with a notification. A source checkout recorded in
  `paths.json` is left alone.
- **Windows: "Restart Router" restarts the router.** The packaged router runs
  as `ClaudeRipple.exe` (Electron as Node), but the process lookup only knew
  `node.exe`, so on every packaged install `restart` found nothing to stop,
  and the scheduled task ignored the start request because it was already
  running. Nothing was restarted, and the command still said "restarted". The
  lookup now matches either executable. Until 0.1.2, the only ways to get a
  new router on a packaged Windows install were the installer (whose own stop
  script did look for `ClaudeRipple.exe`), signing out and in, or a reboot.
- **The router reports its real version.** It said `0.1.0` in 0.1.1 (a literal
  in two places). One `VERSION` constant now feeds the router, the CLI and the
  status page, and a test fails when it drifts from the package manifests.
- **Provider errors are logged with their body.** A 4xx/5xx from a provider or
  from Anthropic recorded only the status; a DeepSeek `401` stayed unexplained
  for a day. The first 300 characters of the error body now go into the router
  log and the Logs page, with anything key-shaped reduced to its last four
  characters. `/api/status` also reports which files the router is running and
  when it started.
- **`claude setup-token` from the app no longer hangs or fails silently.** It
  is an interactive terminal flow; run from the tray or the GUI it waited for
  input that never came or failed with a bare "setup-token failed". That path
  is now `claude-login --setup-token` only, refuses without a terminal with a
  message that says where to run it, and includes what `claude` printed when
  it fails. The app uses the browser sign-in above instead.

## 0.1.1 — 2026-09-15

All four were reported from a Windows install and reproduced here.

### Fixed

- **A mapped request now carries provider authentication only.** The caller's
  own `authorization` and `x-api-key` are dropped before the provider's headers
  are added. Previously only the header that happened to share a name with the
  provider's was replaced, which differs per provider: DeepSeek and MiniMax
  authenticate with `x-api-key`, everything else with `Authorization: Bearer`.
  A DeepSeek mapping answered `401` on every request while the provider form's
  own "Test connection" stayed green — the test sends the provider's headers
  alone, so it certified a path live traffic did not take. An un-routed request
  is unchanged; it really is going to Anthropic.
- **Mapping Haiku 4.5 works.** The app sends `claude-haiku-4-5-20251001` while
  the GUI offers the undated `claude-haiku-4-5`, and route lookup was an exact
  key match, so the mapping never fired and Haiku answered itself. Lookup now
  accepts either form.
- **The native Claude (Anthropic) provider is no longer offered as a mapping
  target.** It serves the OpenAI ingress (Codex) only, but it could be picked in
  Model mapping and given picker entries, and a slot pointed at it failed every
  Claude request with `400`. It is out of the mapping list, creates no picker
  entries, and an existing config that names it passes through instead of
  failing.
- **Windows: "Connect Claude subscription" works.** CLI discovery looked for an
  extensionless `claude` on `PATH` and for the macOS Application Support cache,
  so it always reported "Claude Code CLI not found". It now looks for the
  `.exe`/`.cmd`/`.bat` launchers, checks both AppData roots for the CLI that
  Claude Desktop caches, and runs a `.cmd` launcher through a shell.
  `clauderipple status` reported the cached CLI version from the macOS path too.

## 0.1.0 — 2026-09-14 (first release: macOS + Windows)

The source was published on 2026-09-13; this is the first build. Everything
under "0.1.0 — 2026-09-13" below is included.

### Windows support

ClaudeRipple runs on Windows. Everything was verified end to end against a real
Claude Desktop on Windows 11 arm64 (VM) and on x64 hardware: the picker lists
provider models by name, selecting one routes the call, and the model answers
with its reasoning effort intact.

- Supervisor: a per-user scheduled task, registered without administrator rights.
  It starts the router at logon, and the launcher supervises the process itself —
  Task Scheduler's restart setting only covers failing to *start* a task, so a
  crash would otherwise go unnoticed.
- Certificate trust for the current user only (`Cert:\CurrentUser\Root`). Windows
  shows a confirmation dialog with the fingerprint instead of asking for a
  password; no UAC prompt, and removal asks again.
- Graceful restart over `POST /api/shutdown`, because Windows has no SIGTERM.
- Installer: per-user NSIS, no elevation. **Unsigned** — see the README note.
  Reinstalling and uninstalling stop the supervisor and drain the router first
  (it kept running as `ClaudeRipple.exe` after the tray app closed, so the
  installer failed with "could not be closed" and no hint what to close); the
  uninstaller also undoes the settings.json edits and picker mode while the
  bundled runtime still exists.

### Fixed

- **"Show in the Claude app picker" did nothing on its own.** The provider form's
  checkbox only recorded which models to show; picker mode stayed off and the
  picker never changed, with no message (Windows x64, 2026-09-14). The form now
  says so and offers to turn picker mode on right after saving.
- **ChatGPT sign-in from the GUI.** The provider card said "sign-in needed" and
  gave no way to do it; it has a button now, and the sign-in runs in the
  background while the card waits for the browser to finish.
- **Language.** The tray, notifications and the GUI came up in English on a
  Korean Windows: `app.getLocale()` is Chromium's app locale, not the language
  the user set. The OS preference list is used instead, and the GUI follows it
  unless a language was picked in the GUI itself.

- **Startup.** After a reboot the router could listen minutes after login, and
  Claude Desktop was a blank `ERR_PROXY_CONNECTION_FAILED` window the whole time
  (in picker mode the app has no direct fallback). The launchd agent is no longer
  a throttled `Background` job, `listen()` comes before certificate minting, and
  every start logs its budget. `start` is idempotent: it used to kill a router
  that was still coming up.
- **The app now says what is wrong.** A login item so the tray is there before
  Claude Desktop is, an offline notice that names the cause instead of the
  router-served GUI it cannot load, and a notification after 20s down.
- **Certificates are issued by `node:crypto`**, with no `openssl` binary and no
  new dependency — which is also what let Windows work at all.
- **Security: the admin API refused no cross-site requests.** Binding to
  127.0.0.1 does not keep the browser out: any page could POST to it, and CORS
  hides only the response, not the side effect. Requests carrying another site's
  `Origin` are refused.
- The model mapping table listed every model twice and offered our own injected
  ids as mapping sources.
- The settings window opened smaller than its own content.
- The subagent title hook silently did nothing when its path contained a space.

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
