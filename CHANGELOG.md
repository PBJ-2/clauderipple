# Changelog

## 0.8.3 — 2026-10-06

### Fixed

- **No PowerShell window at every Windows logon** (#49). With Windows Terminal as the default
  terminal — the Windows 11 default — the router task's PowerShell window stayed on screen after
  each logon, because Windows Terminal ignores `-WindowStyle Hidden`. The task now starts
  PowerShell inside a headless console host. Updating re-registers the task; where Windows
  refuses that, the old task is kept and the router runs as before.

## 0.8.2 — 2026-10-06

### Fixed

- **Effort works on API-key providers.** A provider with no effort ladder of its own — DeepSeek,
  Kimi, GLM, MiniMax, Qwen, Groq, Mistral, or any key and URL — stripped the effort you picked and
  the Claude app showed no effort menu for its models. ClaudeRipple now asks each such model: it
  sends a level no vendor defines, and if the endpoint refuses it, the levels it does accept become
  that model's effort menu. An endpoint that accepts anything is left without effort, since it is
  not reading the field. Providers you already set up are measured a minute after the router
  starts; nothing needs re-saving.
- **DeepSeek's API offers low / high / max**, the three levels its thinking mode maps every
  request onto.

## 0.8.1 — 2026-10-06

### Fixed

- **Codex credits are spent instead of refused.** Once a ChatGPT plan's window read 100%, the
  router rested the account until the reset, even though OpenAI serves an account with bought
  credits past its window. An account with credits (or an unlimited balance) now stays in
  rotation; a real usage-limit refusal still rests it.
- **Fewer failed Claude app requests in picker mode.** claude.ai closes idle kept-alive
  connections, and a request written on one as it closed came back as a 502 (about 65 a day
  here, mostly the app's start-up requests). A GET, HEAD or OPTIONS that meets such a socket is
  now sent again; a POST is not.
- **Picker mode on a new Mac.** The ClaudeRipple CA counted as trusted when it was merely in the
  login keychain, so `picker on` could skip the trust step and leave Claude Desktop unable to
  load claude.ai. Trust is now read from the user trust settings, and `picker off` removes the
  certificate either way.
- **The route band said "router not answering"** on Claude Code 2.1.288, which sends plain
  `http://` requests through the proxy too and got 405. They are now relayed.

### Docs

- Any ChatGPT plan that includes Codex works (Plus, Pro, Business; Enterprise/Edu with Codex
  turned on), not just Plus and Pro.
- `ultra` effort is sent as `max`: the Codex backend refuses `ultra` (measured), and Codex's own
  ultra is max reasoning plus its sub-agents, which in Claude Code are Claude Code's subagents.

## 0.8.0 — 2026-10-05

### Added

- **The route, where you type** (Claude Code mods; a switch on the Clients screen, or
  `clauderipple mod on`). A line above the Claude Code prompt says where your last request
  went: model, provider, effort, cache hit and time, colored by provider and result. `Log` or
  `/ripple-log` opens the request log in a side pane, all sessions or just this one; `×` or
  `/ripple-bar` puts the line away. The router now records which Claude Code session sent each
  request (`X-Claude-Code-Session-Id`), and `/api/requests?session=` filters by it.
- **Workers stay on their own model.** The same mod catches a `model` argument on an Agent call
  that would have put a ClaudeRipple worker on a Claude alias (its output cut to 64 tokens) and
  runs it on its own model, and reads a `[[ripple: name@level]]` marker wherever it sits in the
  prompt, not only on the first line.
- **Google Gemini**, on its own wire: an AI Studio key, or a Google account through the
  Antigravity backend with several accounts in rotation. Google's terms name the account route
  as a breach and accounts were suspended for it; the sign-in says so before it starts.
- **Each routed model gets its own effort menu in the Claude app.** DeepSeek and GLM show
  low/high/max instead of Claude's whole ladder; a model that takes no effort shows none.
- **Fast mode on GPT.** `/fast` in Claude Code asks the ChatGPT backend for the Codex fast tier.
- **Updates from the dashboard**: the version row checks and starts an update.
- **A typed model ID** for a provider that lists no models (#42).
- **An explicit Auto mode classifier target** (`autoModeClassifier`, JSON only; #43 by
  @Sociopacific). The README says what pointing it at a weaker model gives up.

### Changed

- **Measuring an OpenCode provider takes one request per model**, its effort ladder read from
  models.dev, four models at a time, instead of about ten sequential requests each (three
  OpenCode Go models had taken 2m33s). The ladders are the catalogue's: glm-5.3-flash is
  low/high/max, where requests had accepted seven levels.
- **Generated workers run at `@high`** unless a marker says otherwise.
- **A clamping tie goes up**: medium on a low/high/max model is high, not low.

### Fixed

- **A settings save no longer undoes what the router wrote.** The dashboard saved the whole
  config from the copy it loaded when it opened, so measured ladders and hand edits came back
  with the next unrelated save. Every save now starts from the router's current config.
- **Routed workers are no longer told to call `advisor`** after the tool was dropped (#47, #48
  by @115dkk).
- **`claude-login` finds the Desktop-cached CLI** in its new `<version>/<hash>/` folder (#45,
  #46 by @115dkk). macOS had the same layout.
- **Codex context overflow** is answered as "prompt is too long", so Claude Code compacts
  instead of retrying the same request (#44 by @Sociopacific); a stream held for that opens
  after five seconds regardless.
- The Codex app sees a GPT model released after the router started; subagent titles keep the
  model and effort under Desktop's new task panel; a provider's connection test reads a
  model-not-found 404 as an accepted key; a Gemini provider waiting on Google's verification
  is not shown as connected, and the page to open is passed on.

## 0.7.0 — 2026-09-29

### Added

- **Worker tools** (`cli.limitWorkerTools`, off by default; a toggle in the dashboard). Generated
  workers get only the read, edit, run, search and skill tools instead of inheriting every MCP
  server and plugin tool of the session. One worker's first request fell from 32,942 to 8,823
  tokens. Such a worker cannot use a browser or the iOS Simulator; keep those in an agent file of
  your own.
- **Images from the ChatGPT subscription.** `clauderipple image "<prompt>" -o file.png`, with
  `--aspect square|landscape|portrait`, `--transparent`, `--format` and `--ref FILE` for reference
  images. Underneath is `POST /api/image` on the admin port, which answers with the image itself.
  Generated workers are told the `curl` form, so a worker with only Bash can make one. The backend
  chooses resolution and quality; about 30 seconds an image.

## 0.6.0 — 2026-09-28

Both suggested in #8 by @artisthanbohee-del.

### Added

- **Updates from the tray and the CLI** (#39). The tray checks for a new version at start and
  twice a day and offers it in its menu; **Check for Updates…** asks on demand. In a terminal:
  `clauderipple update` (`--check` only reports). It updates the way ClaudeRipple was
  installed — the install script again, or npm into the same prefix — and restarts the router
  on the new version. The standalone app points to the releases page instead.
- **Usage of each Claude subscription account** (#40): the five-hour and weekly limits of the
  current Claude login and of every account added in ClaudeRipple, on the Health screen, in the
  Claude provider's Accounts tab and in the tray menu. Read from the same endpoint Claude
  Code's `/usage` uses, so an account that has not answered anything yet still has a number.
- **The version in the tray's About box.**

### Fixed

- **Re-running the installer now restarts a router still running the old version.** Before,
  the files changed but the router kept the old code until the next login — on Windows and
  Linux always, since an unchanged task or service is not registered again.
- **The tray survives updates.** Its Electron (~270MB) was fetched into the package folder, and
  every update deleted it; on Windows a running tray could make the update fail. It now lives in
  `~/.clauderipple/tray-runtime`, and the install scripts move an existing copy there instead of
  fetching it again. An install made with plain `npm install -g` fetches it once more with
  `clauderipple tray --install`.
- **The tray installed from npm reports its own version**, not Electron's: its package manifest
  carried none.

## 0.5.1 — 2026-09-28

### Fixed

- **Prompt caching on anthropic-compatible providers** (#36, #37, by @grapefruit0205).
  Claude Code's billing header opens the system prompt and changes every turn, so a
  vendor with a plain prefix cache cached nothing after it: DeepSeek via Alibaba Bailian
  reported 0.3% over two days. The header is now dropped for these providers, as it
  already was for the translated ones; measured 99% on the next turns.
- **Switching a session from a translated model to Claude.** The translated providers
  return reasoning as unsigned, sometimes empty `thinking` blocks, and Anthropic refused
  every turn after the switch with "each thinking block must contain thinking". Unsigned
  thinking is now dropped before a request reaches Anthropic.
- **Windows install when the user name equals the computer name** (#38, reported by
  @haemilchu). The scheduled task is registered as `DOMAIN\user`; the bare name did not
  resolve and registration failed with 0x80070057 before `settings.json` was written.
- **Windows reinstall no longer re-registers a correct task.** The check read two
  battery settings under names the task object does not have, so it never matched and
  every install registered again — what fails on machines that protect the task.
  Checked in a Windows 11 VM.
- **`clauderipple` in a new PowerShell window** (#38). The installer leaves no `.ps1`
  shim, so PowerShell runs the `.cmd` under the default execution policy.

## 0.5.0 — 2026-09-24

Linux, and four fixes from the first outside contributions.

### Added

- **Linux** (#28, #33, #34, by @grapefruit0205). `install`, `status`, `restart` and
  `uninstall` work where there is a systemd user session: the router runs as
  `~/.config/systemd/user/clauderipple.service`, with no sudo. A health self-exit is
  restarted after two seconds, and a stop waits out the 90-second drain. Picker mode
  trusts the local CA in the NSS database Chromium reads (`~/.pki/nssdb`, your user
  only) and needs `certutil` (`libnss3-tools` / `nss-tools`). Measured by the
  contributor on Ubuntu 24.04 x64 with Claude Desktop 2.2553.13.

### Fixed

- **`npm test` no longer rewrites your real `~/.claude/settings.json`** (#16, #26, #30).
  The admin tests isolated the router's home but not the Claude settings path, so a
  test run pointed `NODE_EXTRA_CA_CERTS` at a temp directory it then deleted, and every
  Claude Code session on the machine failed until the file was fixed by hand.
- **A failed install leaves `settings.json` alone** (#27, #31). The proxy settings are
  now written only after the end-to-end probe passes, and `picker on` checks the
  router is answering before it points Claude Desktop at it.
- **Anthropic-compatible providers keep the conversation after a tool call** (#29, #32).
  Claude Code's `thread: continue` carries only the new messages; the router stripped
  the field and forwarded that delta, so the model got orphan tool results and no task.
  It is now refused as for the translated providers, and the CLI resends the full turn.
- **`picker on` and `status` from a PowerShell 7 terminal on Windows** (#35). Windows
  PowerShell inherited PowerShell 7's module path and lost the `Cert:` drive: `picker on`
  stopped at "Cannot find drive 'Cert'" and `status` called a trusted CA untrusted.
  Every `powershell.exe` we start now drops the inherited `PSModulePath`. Reproduced
  and checked in a Windows 11 VM.

## 0.4.1 — 2026-09-24

### Fixed

- **The tray starts from an npm install** (#8). After 0.3.1 it launched as
  Electron but died at once with "exports is not defined in ES module scope": the
  tray is CommonJS and the package root says `"type": "module"`. The tray now has
  its own `package.json`. Checked by starting it from the packed package.

## 0.4.0 — 2026-09-24

Several ChatGPT accounts, for Claude Desktop and for Codex.

### Added

- **Several ChatGPT accounts.** `clauderipple login` (or **+ Add ChatGPT account**
  in the dashboard) adds an account instead of replacing the one you had; the
  sign-in asks who is signing in, so the browser's current ChatGPT session is not
  silently reused. When an account hits its limit, the same request moves to the
  next one before anything reaches the client, and the spent account rests until
  the window the backend reports resets. A conversation stays on the account that
  answered, to keep its prompt cache. A 401 gets one token refresh and a replay;
  only a freshly minted token refused again asks for a new sign-in. Accounts live
  in `~/.clauderipple/chatgpt-accounts.json` (0600); the old single login is moved
  there on the first sign-in. The Codex CLI's own login still takes part, last.
- **Accounts tab for ChatGPT** in the dashboard: each account's 5-hour and weekly
  usage, when a resting one is back, and pause/resume, rename, remove, use now and
  sign in again.
- **Codex's GPT goes through the account pool.** `clauderipple codex on` now also
  points Codex's built-in OpenAI provider at ClaudeRipple. Codex keeps its ChatGPT
  sign-in; its GPT requests reach ChatGPT unchanged except for the account, so when
  one account runs out Codex carries on with the next — no sign-out. With no account
  added, or every one at its limit, Codex's own login is used. An `openai_base_url`
  of your own is never overwritten; `clauderipple codex off` undoes it.

### Changed

- `clauderipple logout` removes every ChatGPT account added with `login`.
- `/api/status` keeps `chatgpt.quota` (the account that answers next) and adds
  `chatgpt.accounts`, one entry per account.

## 0.3.1 — 2026-09-24

Fixes for three reports against 0.3.0.

### Fixed

- **Claude account rotation no longer breaks requests with a 400** (#15). With
  `accountPool` on, the account's `anthropic-beta` header replaced the client's,
  so fields Claude Code enables per request (`cache_control.scope`,
  `context_management`, …) were refused with `Extra inputs are not permitted`.
  A conversation pinned to an added account failed on every retry, because a
  400 does not move it. The account now supplies identity only: its OAuth flags
  are added to the client's, on the first attempt and on every retry.
- **The Windows tray appears** (#8). It was started with `ELECTRON_RUN_AS_NODE`
  set to an empty string, which macOS Electron treats as unset and Windows
  Electron treats as set, so on Windows the tray ran as plain Node and exited
  while the CLI reported "tray started". The variable is now removed.
- **GLM-5.3 and GLM-5.3 Flash in the Z.AI preset** (#14). Z.AI serves no model
  list, so the preset's list is the whole picker, and it stopped at GLM-5.2.

## 0.3.0 — 2026-09-23

Everything on `main` since 0.2.0. The account rotation that issue #8 asked for
was on `main` from 2026-09-20 while the README already described it, but no
release carried it. A user looking for the setting in 0.2.0 could not find it.

### Added

- **Claude subscription account rotation.** A native Anthropic provider can opt in
  with `accountPool: true` and use the current Claude Code/Desktop login followed by
  every OAuth account added through ClaudeRipple. Conversations stay on the account
  that answered to preserve the prompt cache; before any response reaches the client,
  429, 401 and transient upstream failures can move the same turn to the next account.
  Stored grants refresh independently with single-flight and compare-and-swap safety,
  rejected accounts are isolated until re-login, and the dashboard can rename or
  remove them without exposing a token or upstream account id. Existing single-account
  OAuth grants migrate to the private `~/.clauderipple/claude-accounts.json` file on
  the first pool write. This applies to native Claude Desktop/Claude Code Messages;
  the translated OpenAI ingress for Codex picks one highest-priority available login
  per request but deliberately does not rotate accounts.
- **ChatGPT subscription web search.** When `webSearch` explicitly names a
  ChatGPT provider, Claude Code's separate search request uses the subscription's
  Codex hosted-search tool instead of silently consuming Anthropic quota. The
  adapter requires a reported search and URL citations, preserves allowed-domain
  filters, and refuses unsupported blocked-domain filters.
- **New ChatGPT models appear without an update.** The model list is read from
  the Codex catalogue the subscription serves, not from a list in the code, so
  GPT-6 Sol and GPT-6 Luna showed up the day they shipped. If the catalogue
  cannot be read, a built-in list is used instead. Newly found models are
  offered unticked. Claude Opus 5.5 is in the Claude list.
- **Credential pools and route fallbacks.** A provider can hold several keys. A
  rate-limited or refused key rests until its cooldown ends, and the turn moves
  to the next key before the client sees the failure. A model slot can name
  fallback providers for when the primary has nothing usable left. The
  dashboard shows which credential is resting, and until when.
- **OpenCode Go and OpenCode Zen presets.** One OpenCode Go subscription is one
  preset covering all three of its endpoints, each with the session header its
  prompt cache needs. Each model's request format is taken from the vendor's
  published endpoint table. After a provider is saved, its models are measured
  for request format and effort levels instead of being assumed.
- **A ticked model is a subagent.** Every model ticked in the GUI gets a
  generated agent file. A model that only one provider carries routes there
  without a hand-written rule. A model no provider carries is refused with a
  message naming it, instead of being sent to Anthropic and coming back 404.
- **Web search in a routed session.** It reaches a provider that runs the
  search tool itself, uses ChatGPT's hosted search when configured, and is
  refused with a reason where no provider can run it.
- **Claude Code's own model slots as a setting.**

### Fixed

- **A cut-off stream is retried, not taken as the answer.** An upstream that
  closed the stream without finishing used to become an empty, successful
  turn. A subagent then stopped silently, which is how long Muse runs appeared
  to stall and die. The turn now fails as overloaded, and Claude Code retries it.
- **The Codex prompt cache holds across turns again.** The conversation is
  named to the Codex backend, which now keys its cache on that name.
- **The provider form no longer wipes settings it does not show.** Saving a
  ChatGPT provider in the GUI dropped fields such as `instructionsAppend`.
- **The request log shows a request's whole input.** A fully cached Anthropic
  turn used to read as a 2-token request. The model column no longer shows
  the agent file's default effort next to the effort that was actually sent.
- **Routed models keep their own context window,** including across a model
  switch, and tool names the wire rejects are rewritten and restored.
- **Screenshots in tool results survive translation.**

- **Remote Control works through the forward proxy.** Claude Code sends its
  registration, polling and heartbeat requests in HTTPS absolute-form rather
  than CONNECT. ClaudeRipple now rewrites only the request target, strips proxy
  headers and relays it over TLS outside model routing. The connection closes
  after one request so another proxy target cannot leak to the first origin.
- **Windows reinstall is idempotent without elevation.** An existing scheduled
  task is reused only when its action, principal, trigger, restart policy,
  execution limit, instance policy and battery settings all match the intended
  per-user task. A foreign or stale task is never trusted.

## 0.2.0 — 2026-09-16

The first release published to npm, and the reason the number moves to 0.2:
ClaudeRipple is installed with one command instead of a signed application,
and the Electron window is gone in favour of the dashboard in your own browser.

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
- **One command installs everything, Node included.** `curl … install.sh | sh` on
  macOS, `irm … install.ps1 | iex` on Windows. The script uses a Node 24+ already
  on PATH and otherwise downloads the official build into `~/.clauderipple/runtime`,
  checked against the checksum nodejs.org publishes, then runs setup. The package
  goes under its own prefix, so nothing needs elevation and uninstalling is one
  directory. The Node version is resolved at install time rather than pinned.
- **The tray is a command, and its runtime is fetched on request.** `clauderipple
  tray` starts the menu-bar / tray app; `--install` fetches Electron the first
  time. Electron is 270MB and is not a dependency, so a plain install is under a
  megabyte and every other command works without it.

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

- **`uninstall --purge` removes the home directory on Windows.** It unregistered
  the scheduled task but left the router running, and a running router holds
  `router.log` open, so the removal failed with `EPERM` and left everything
  behind. The router is stopped first now, and the removal is retried briefly
  while Windows releases the handle.

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
