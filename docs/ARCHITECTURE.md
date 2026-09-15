# ClaudeRipple — Architecture and verified facts

Last verified: 2026-09-11 against Claude Desktop 1.52386.0, Claude Code CLI 2.1.266.
Everything below is backed by a document, a file, or a measured log. Items marked
**(assumption)** are not.

## 1. The mechanism

```
~/.claude/settings.json
  env.HTTPS_PROXY         = http://127.0.0.1:<port>
  env.NODE_EXTRA_CA_CERTS = <state dir>/ca.pem

CLI: CONNECT api.anthropic.com  → ClaudeRipple terminates TLS (leaf cert signed by ca.pem)
     per request:
       model matches a route  → rewrite model (+effort), send to provider adapter
       otherwise              → forward byte-for-byte to api.anthropic.com over real TLS
CLI: CONNECT anything else      → blind tunnel
```

Why this path is stable:

- Anthropic's [corporate proxy docs](https://code.claude.com/docs/en/corporate-proxy)
  state that in Desktop sessions the CLI reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`
  and `NODE_EXTRA_CA_CERTS` from managed settings and `~/.claude/settings.json`,
  and that before v2.1.217 these were ignored. The change was deliberate and its
  direction was "narrow the sources", not "remove". Enterprise TLS-inspecting
  proxies (Zscaler, Netskope) are named as supported.
- The app itself does **not** pass `settings.json` env to the CLI. The CLI reads
  it. The app only injects OS proxy settings and its own CA bundle, and only when
  the caller env does not already have the key (`NXe` merge in
  `index.chunk-C0sgyfNn.js`). Managed (enterprise) settings are the one tier the
  app force-overrides. App updates therefore do not touch this path; **CLI
  updates are the only moving part.**
- The app auto-updates the CLI independently of the app (checks
  `downloads.claude.ai/claude-code-releases/stable` every ~4h, signed manifest).
  Health checks must key on the CLI version directory
  `~/Library/Application Support/Claude/claude-code/<ver>/`.
- No certificate pinning on the CLI spawn path. `setCertificateVerifyProc` exists
  only for the Chrome-extension pairing partition; `rejectUnauthorized` only for
  the remote-control websocket.
- The CA is never installed in the keychain. `NODE_EXTRA_CA_CERTS` is a Node-only
  trust addition, no admin password, no effect on other programs.

## 2. What the app does with the official third-party setting (why competitors lose)

Verified in `app.asar` (`.vite/build/index.chunk-C0sgyfNn.js`, `-2CuMdv3h.js`):

- The gateway setting (`inferenceGatewayBaseUrl`) is a **whole-app deployment
  mode switch** (`Wl()` → 3P class `Jqt` vs 1P class `Qqt`).
- 3P mode loads `app://localhost` (local `ion-dist` bundle) instead of
  `https://claude.ai`; claude.ai `/api/`, `/v1/` calls are stubbed with
  `custom_3p_not_available` 503.
- 3P "Chat" is a Claude Code `local-agent` session, not claude.ai chat.
- 3P disables the Sessions bridge (Remote Control): `shouldEnableSessionsBridge(){return!1}`,
  `hasClaudeAiProductFeatures(){return!1}`, side sessions unavailable.
- 1P mode routes nothing through the gateway (`managesProviderRouting(){return!1}`).
  Partial application ("chat on Claude, Code on gateway") is impossible for anyone.

Consequence: the product boundary is the **Code tab and its subagents**. General
chat is out of reach for every approach, ours included.

## 3. Model picker

- The picker list is produced by the claude.ai web frontend (remote renderer),
  from the `model_selector_config` field of the claude.ai **bootstrap** response
  (also pushed live via `bootstrap_push_revision`). Verified in
  `shared-common-1-rSOeStkD.js` (`model_selector_config:e.model_selector_config`)
  and `shared-2-x4ME0hE_.js` (`modelSelectorConfig` → catalog → picker).
- The renderer reports the list to the app via IPC `setAvailableCodeModels(modelIds)`
  (`shared-16-sxOyUBaU.js`). The 1P app stores it and **does not validate**
  (`validateSessionModel(e,t){return{ok:!0}}`). The chosen id goes to the CLI as
  `--model <id>` or a `set_model` control request, string-checked only.
- So: if the picker ever shows `gpt-5.6-sol`, the rest of the chain passes it
  through unchanged. But the picker list travels over claude.ai web traffic in the
  Electron renderer, which a CLI-only proxy cannot see.
- **v1 decision: alias mode.** Map existing picker entries (e.g. Opus 4.8 →
  GPT-6 Astra) and make the mapping visible in the ClaudeRipple GUI.
- **Picker mode (implemented 2026-09-11, `clauderipple picker on`).** Verified in
  the app's main bundle (`index.pre.js`): the app reads `egressProxyUrl` from its
  own Config Library (`~/Library/Application Support/Claude-3p/configLibrary/
  _meta.json` → `appliedId` → `<uuid>.json`, flat keys; the `-3p` userData
  suffix is used in both deployment modes, `AW()` in `index.pre.js` — the plain
  `Claude/` dir is NOT read, measured 2026-09-13: app log said "proxy for
  https://claude.ai resolved (direct)") and applies it at start
  as Chromium switches `--proxy-server` + `--proxy-bypass-list` (`DK()`), so the
  renderer's claude.ai traffic goes through the same proxy. No MDM, no OS proxy.
  The bootstrap is fetched by the page itself at
  `/edge-api/bootstrap[/{org}/app_start]?statsig_hashing_algorithm=djb2&...`
  (`window.__BOOTSTRAP_PRELOAD__`), top-level `model_selector_config`. The CA is
  trusted in the **login keychain only** (`security add-trusted-cert -r trustRoot
  -k login.keychain-db`; the user types their password in macOS's dialog). The
  router mints a `claude.ai` leaf from the CA (SNI), passes claude.ai through
  byte-for-byte except the bootstrap, where `cli.extraModels` are cloned from an
  enabled Claude entry into every non-`chat` surface. Open question until the
  first real run: exact surface ids and whether the renderer filters ids; the
  router logs `PICKER injected … surfaces: …` on each bootstrap.
- Injecting `additional_model_options` into the Claude Code bootstrap response
  does **not** reach the app picker (measured; the app never reads that field).
- **Windows uses the same mechanism** (measured end to end in a Windows 11 VM,
  2026-09-14: picker listed the GPT models, a call routed, the model answered).
  Two things differ and nothing else does:
  - The Config Library lives at `%LOCALAPPDATA%\Claude-3p\configLibrary\`, not
    `%APPDATA%`. The app creates `Claude-3p` itself but leaves it empty —
    `configLibrary/` is ours to write, on both platforms (`_meta.json` had
    `previousAppliedId: null` on a machine that had never been touched).
  - The CA goes into `Cert:\CurrentUser\Root`. Windows shows a confirmation
    dialog with the fingerprint instead of asking for a password, and **no UAC
    prompt**: a standard, non-elevated user can do it. It asks a second time when
    the certificate is removed, so `picker off` prompts too.
  The app's own log line confirms the proxy took effect:
  `[egress-proxy] pinned to fixed proxy at 127.0.0.1:<port>; OS proxy settings ignored`.

## 4. Provider adapters

- **Anthropic-compatible providers** (DeepSeek, Kimi/Moonshot, GLM, MiniMax and
  others expose `/v1/messages`): host + model rewrite only, no translation. This
  is the whole reason `claude-code-router` works with just `ANTHROPIC_BASE_URL`.
  **(assumption — verify each provider's endpoint before shipping a preset.)**
  A routed request authenticates as the provider and only as the provider: the
  caller's `authorization` and `x-api-key` are dropped before the provider's own
  headers are added. Presets differ in which header they use (`x-api-key` for
  DeepSeek and MiniMax, `Authorization: Bearer` for the rest), so relying on the
  provider header to overwrite the caller's by name covers one of the two at
  best. An un-routed request keeps its headers — that one really is going to
  Anthropic. Enforced by `packages/router/test/proxy-headers.test.ts`.
- **ChatGPT subscription (Codex backend):** needs a translation layer,
  Anthropic Messages ⇄ OpenAI Responses, plus OAuth (PKCE) login against
  `chatgpt.com/backend-api/codex`. The upstream endpoint is unofficial and may
  change.
  - Reference implementations, used as **behavioral specs only, no code copied**:
    [husniadil/proxenos](https://github.com/husniadil/proxenos) (Rust, Apache-2.0;
    measured cache hit 97.8–98.7% in daily use) and
    [insightflo/chatgpt-codex-proxy](https://github.com/insightflo/chatgpt-codex-proxy)
    (TypeScript, MIT; OAuth, tool calling, SSE).
  - Cache is the make-or-break metric. An earlier translator of our own (a
    GPT layer over the Claude Code harness, before ClaudeRipple) lost
    `cache_control` breakpoints and re-signed reasoning, giving 12–20% cache
    hit and 8× input token spend. That figure is ours, not a measurement of
    opencodex or any other project. **Acceptance: ≥90% cache hit on a
    multi-turn tool-using session, measured from upstream
    `input_tokens_details.cached_tokens`.**
  - `output_config.effort`: `none…max` accepted by terra/sol/astra, `ultra`
    rejected (luna accepts it). Clamp `ultra` → `max`.
  - Model self-introduction is not evidence of routing. Verify by upstream
    usage records.
  - **Implemented 2026-09-11** in `packages/router/src/providers/chatgpt/`.
    Wire facts used: endpoint `POST {base}/codex/responses` with base
    `https://chatgpt.com/backend-api`; headers `authorization: Bearer`,
    `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`,
    `originator: codex_cli_rs`; body fields `model, instructions, input, tools,
    tool_choice, parallel_tool_calls, reasoning{effort,summary}, text{verbosity},
    store:false, stream:true, prompt_cache_key`. OAuth: `auth.openai.com/oauth/
    authorize|token`, client `app_EMoamEEZ73f0CkXaXp7hrann`, redirect
    `http://localhost:1455/auth/callback`, PKCE S256, account id from the access
    token claim `https://api.openai.com/auth.chatgpt_account_id`.
  - **Verified live 2026-09-13 and cut over** (the user's config now uses this
    adapter; proxenos is no longer in the chain). Measured against the real
    backend: streamed text, tool calls (`tool_use` + `input_json_delta`),
    multi-turn with `tool_result`, non-streaming, `count_tokens` (local
    estimate), `@effort` suffix → `reasoning.effort`. Prompt cache on
    `gpt-5.6-terra`: 0 on the first call after idle, then **7680/7801 = 98.4%**
    on every following call with the same `prompt_cache_key`. `gpt-5.6-luna`
    reported `cached_tokens: 0` on identical repeats (backend behavior, also
    through proxenos) — do not judge the cache metric on luna.
  - Quota comes from the backend's **`x-codex-*` response headers** on every
    response (`x-codex-primary-used-percent`, `-window-minutes`,
    `-reset-after-seconds`, `-reset-at`, `x-codex-plan-type`); the
    `codex.rate_limits` SSE event was not sent in any measured response. The
    adapter reads both.
  - **Tool schema scrub.** The backend validates every `pattern` in
    `tools[].parameters` with a regex engine that rejects lookaround and
    backreferences, and one bad pattern fails the whole request with 400
    `invalid_function_parameters` ("… is not a 'regex'"). Claude Code's
    `Artifact` tool carries `^(?!__.*__$)…` since ~2.1.266, which broke every
    GPT request through proxenos as well. `normalizeSchema` drops such patterns
    (the client validates its own inputs). Upstream error bodies are now logged.
  - Cache-safety decisions: thinking blocks are dropped from replayed history;
    no reasoning `include`; identity line and `instructionsAppend` are constant
    text; `prompt_cache_key` = sha256(metadata.user_id + first user message).

### 4a. Claude Code request shapes a translator must handle (measured 2026-09-13, CLI 2.1.266)

- **Server-side threads ("tether").** The first request of a session carries
  `thread: {type:"create"}` and the full history; later turns carry
  `thread: {type:"continue", previous_message_id: <our last assistant msg id>}` and
  **only the new messages** (tool results + attachments). A translated provider has no
  such state, so the router answers a `continue` with HTTP 400 and
  `error.details.error_code = "thread_unsupported_request"`; the CLI then resends the
  turn stateless and keeps the session stateless on that model. Accepting the delta
  instead made the model see an orphan `tool_result`, answer "무엇을 도와드릴까요?", and
  kept `cached_tokens` stuck at the tools prefix. `thread`/`diagnostics` are stripped
  from `create` requests before forwarding.
- **Per-turn billing telemetry.** The first system block is
  `x-anthropic-billing-header: … cch=<hash> …` and the hash changes every turn. Dropped
  from `instructions`, otherwise nothing after it is ever cached. With it dropped and
  sessions stateless, continuation turns measured 94–99% cache hit (`cached_tokens` /
  total input) on gpt-5.6-terra.
- **Orphan tool results.** Side queries can start with a bare `tool_result`; the
  Responses API rejects a `function_call_output` without its `function_call`
  ("No tool call found"), so such results are sent as user text.
- **Usage snapshots.** The CLI snapshots `message.usage` per streamed content block,
  before `message_delta`; `message_start` therefore announces an input estimate
  (char/4, floored by the last measured total for the conversation) so the app's
  token counter and the CLI's context accounting are not zero.

- **Provider base path.** Anthropic-compatible vendors mount the API under a path
  (`https://api.deepseek.com/anthropic`, `https://openrouter.ai/api`,
  `https://dashscope-intl.aliyuncs.com/apps/anthropic`); the router prepends it to
  the CLI's `/v1/messages…`. Forwarding to the bare host returned the vendor's
  website as HTTP 200 HTML (measured 2026-09-13).
- **Anthropic-only request features.** Claude Code sends `thinking.block_binding`,
  `defer_loading` tools, `context_management`, `output_config.effort`, and an
  `anthropic-beta` header; compatible vendors answer 400 for them
  (`Thinking.block_binding is not supported…`, `Deferred custom tools are only
  supported on Anthropic models…`). `packages/router/src/compat.ts` strips or
  clamps them per provider capability (preset `effortLevels` / `thinking`).
- **New picker entries need a new session.** The CLI validates `set_model`
  against the model list it received at session start (`additional_model_options`
  in its bootstrap); a model added afterwards is "not a recognized model id"
  until a new session starts.

### 4b. OpenAI ingress (Codex CLI and other OpenAI clients)

- A second, plain HTTP listener binds **only** `127.0.0.1` on
  `listen.openaiPort` (default `listen.port + 2`). It accepts any syntactically
  valid local `Authorization: Bearer …` value but never forwards that value.
  It provides `POST /v1/responses`, `POST /v1/chat/completions`, and
  `GET /v1/models`.
- Both POST endpoints resolve their requested `model` with the same
  `routes`/`aliases`/`direct` logic as the proxy. `chatgpt` and
  `openai-compatible` targets are rejected: Codex already has native paths for
  them. Targets are `anthropic-compatible`, or native `anthropic`.
- Configure a native API-key target as
  `{ "type":"anthropic", "auth":"api-key", "apiKey":"…" }` (or set
  `ANTHROPIC_API_KEY`). Configure a compatible target as today, for example an
  `openrouter` provider at `https://openrouter.ai/api` with its own `headers`.
  Ingress writes requests to the ordinary RequestLog as `kind: "messages"`,
  with `note: "openai-ingress responses|chat"`.
- `anthropic.auth: "claude-code"` reuses a Claude subscription credential and
  is subject to Anthropic's terms. Source precedence is: (1) the latest valid
  **in-memory** header snapshot observed from an un-routed Claude Code
  `api.anthropic.com/v1/messages` request (expires after 12 hours and vanishes
  on router restart), (2) `CLAUDE_CODE_OAUTH_TOKEN`, (3) Claude Code Keychain
  service `Claude Code-credentials`.claudeAiOauth, (4)
  `~/.claude/.credentials.json`, then (5) ClaudeRipple's own
  `<home>/claude-auth.json` setup-token file. The observed source retains only
  `Authorization`, `anthropic-version`, `anthropic-beta`, `user-agent`,
  `x-app`, `x-stainless-*`, and `anthropic-client-*` request headers and sends
  that exact set upstream. It is never persisted, logged, included in RequestLog
  or picker diagnostics, debug dumps, or any admin API response. Keychain/file
  reads are cached for 60 seconds; ClaudeRipple **never refreshes or writes**
  Claude Code's own credential. Expiry becomes OpenAI-style 401 `Claude Code
  login expired — open Claude Code once to refresh`.
- `clauderipple claude-login` runs the locally installed `claude setup-token`
  browser flow and stores only its resulting long-lived token in
  `<home>/claude-auth.json` with mode `0600`; `claude-logout` removes that file.
  The command first finds `claude` on PATH, then the newest Desktop-bundled CLI.
  It never prints the token. `setup-token` availability is CLI-version dependent.
- **OAuth wire behavior (behavioral-spec evidence; not documented public API
  contract):** the behavior-only OpenCodex source uses `Authorization: Bearer`,
  `anthropic-version: 2023-06-01`,
  `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, a Claude Code
  request fingerprint/session ID, and `custom_` prefixes for non-builtin tool
  names. ClaudeRipple independently implements those behaviors; it does not
  copy reference code. The ingress puts the required compatibility first system
  block `You are Claude Code, Anthropic's official CLI for Claude.` and
  **nothing else in `system`**. Measured 2026-09-13 with a live subscription
  credential: a request whose system prompt carries Codex's long instructions
  after the identity line answers HTTP 429 `{"type":"rate_limit_error",
  "message":"Error"}` (not a real quota limit; a tiny request passes at once).
  So in borrowed-login mode the client's `instructions` / system messages travel
  as the first block of the first user message, wrapped in
  `<operator_instructions>` and cache-marked; with an API key they stay in
  `system`. Also measured: `claude-haiku-4-5` rejects `output_config.effort`
  with 400, so effort is sent only to models matching
  `claudeSupportsEffort()` (Opus/Sonnet/Fable 4.6+ and 5). Verified live:
  Sonnet 5 and Haiku 4.5 with Codex's full instructions, tools and effort → 200;
  `codex exec --profile clauderipple -m claude-sonnet-5` → exit 0.
- Responses conversion is stateless. A non-null `previous_response_id` receives
  HTTP 400 `previous_response_id unsupported` rather than silently losing
  history (Codex sends `null` when it carries the full transcript itself).
  `instructions` plus message/input items become Anthropic `system` plus
  `messages`; text, base64/URL images, function calls, and function outputs are
  preserved; reasoning items are dropped. Function tools and tool choice map to
  Anthropic tools/tool_choice. `max_output_tokens` → `max_tokens`, and
  `temperature` is preserved. `reasoning.effort` → `output_config.effort`; this
  ingress does not invent a thinking-token budget because that would change
  the caller's requested output ceiling.
- Cache discipline: serialization has no timestamps; cache breakpoints are put
  on the system block, the final tool definition, and the final user content
  block. Upstream Anthropic usage maps `cache_read_input_tokens` to Responses
  `usage.input_tokens_details.cached_tokens`.
- Anthropic Messages stream conversion emits `response.created`, output-item
  add/done, text and function-argument deltas/done, then `response.completed`.
  Chat Completions uses the same mapper and emits `delta.tool_calls` plus a
  terminal `[DONE]`.
- Codex 0.146.0-alpha.9.2 on the development machine supports profile layers
  at `$CODEX_HOME/<name>.config.toml` (`--profile <name>`). `clauderipple codex
  on` adds only a marked `[model_providers.clauderipple]` block in
  `$CODEX_HOME/config.toml` and a marked selection block in
  `$CODEX_HOME/clauderipple.config.toml`; `off` removes only those blocks after
  a backup. The provider uses `base_url = "http://127.0.0.1:<openaiPort>/v1"`,
  and `wire_api = "responses"`; no `env_key`, so the Codex desktop app (which
  has no shell environment) can use it too. The ingress accepts a missing
  `Authorization` header and rejects only a malformed one.

Sources: [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
[Claude Code authentication and credential management](https://code.claude.com/docs/en/authentication),
and the behavior-only [OpenCodex source](https://github.com/lidge-jun/opencodex)
inspected 2026-09-13. The latter is not an Anthropic guarantee.

### 4c. `openai-compatible` providers (implemented 2026-09-13)

- This adapter translates Anthropic Messages into either OpenAI **Chat Completions**
  (the default `wire: "chat"`) or stateless **Responses** (`wire: "responses"`),
  then maps SSE back into Anthropic `message_start`, content-block, `message_delta`,
  and `message_stop` events. It supports text, base64/URL images, function tools,
  tool results, non-streaming replies, and local `count_tokens` estimates.
- Translation deliberately strips `thinking`, `context_management`, `thread`,
  `diagnostics`, and `container`; `thread:continue` is refused exactly as in §4a so
  the CLI resends a full stateless history. The per-turn
  `x-anthropic-billing-header` system block is also stripped because its changing
  value breaks every vendor's stable-prefix cache opportunity. Orphan tool results
  are sent as user text, not a tool result with no antecedent call.
- `output_config.effort` is emitted only if provider `caps.reasoning` is `"effort"`,
  clamped to `caps.effortLevels`; Chat Completions receives `reasoning_effort`, while
  Responses receives `reasoning.effort`. A discovered model's explicit
  `effortLevels` overrides provider defaults, including `[]` for “no effort”. When
  an OpenRouter `/models` entry has `supported_parameters`,
  `reasoning_effort` maps to `[low, medium, high]`; its absence maps to `[]`.
  Vendors that do not report that field keep their configured fallback. Chat wire
  forwards Anthropic `stop_sequences` as `stop`; Responses wire deliberately omits
  them because its common stateless schema has no corresponding universal field.
- We do not assert a provider-wide cache hit rate: the adapter records
  `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` when
  a vendor returns it, and otherwise logs zero cache read. The byte-stable
  translated history preserves cache eligibility but does not create vendor caching.
- Presets use OpenAI-compatible `GET /models` discovery followed by a one-token
  `POST /chat/completions` authentication check. 401/403 is a bad key; 402 or an
  insufficient-credit response means the key is accepted but the account has no
  credit. Preset endpoint and capability claims cite the vendor's official docs in
  `packages/router/src/presets.ts`.

## 5. Failure modes that must not exist in the product (all observed)

| Observed | Product requirement |
|---|---|
| Router stuck with DNS resolution failure for 10h (`gaierror`, 22,795 lines); 11 remote-control workers died within 17s; app kept showing remote as available | Consecutive upstream connect failures → self-exit; supervisor restarts (launchd KeepAlive). Health view shows remote-worker liveness. |
| Python 3.9 asyncio GC'd connection handler tasks; 1 in 10 requests vanished with no log line (`Task was destroyed but it is pending`); surfaced as "retry" banners, `Connection lost mid-response`, and subagent compaction failures | Keep strong refs to in-flight connections; log every request completion; an integration test that counts requests in vs. responses out. |
| Translator daemon (proxenos) was not supervised; it died and every GPT request failed with connection refused | One supervisor for the whole chain; the router reports adapter health, not just its own. |
| `router.log` grew to 17MB | Log rotation by default. |
| A `restart` (SIGTERM) killed 5 in-flight requests; a streaming answer died mid-response and Claude Desktop showed a connection error (2026-09-11 17:00) | SIGTERM drains: stop accepting, wait for `/v1/messages` calls (up to 90s), then exit. Long-poll worker streams are not waited for (the CLI reconnects them). Never restart the live router casually. |
| `launchctl kickstart -k` SIGKILLed the router ~5s after its SIGTERM; the drain was cut with 2 model calls open (2026-09-13 13:35) | `clauderipple restart` sends SIGTERM itself, waits for the process to exit (up to 120s), and lets launchd KeepAlive relaunch it. `kickstart -k` is only the fallback. |
| Drain ran the full budget and still had 2 calls open: `server.close()` stops new TCP connections only, and the CLI kept sending new requests down its existing tunnels (in-flight went 2→1→2; 2026-09-13 13:38) | While draining, new `/v1/messages` requests get `503` + `retry-after: 3` + `connection: close` before the body is read (the SDK retries 5xx and reconnects to the relaunched router). The in-flight count can then only fall. Verified: a 47s stream finished, the next call got 503, exit 1s later. |
| Every GPT request failed with 400 after a Claude Code update added a lookahead regex to the `Artifact` tool schema (2026-09-13; proxenos too) | Tool-schema scrub in the translator (§4). Upstream error bodies are logged, never just the status. |
| Unknown-model context window defaulted to 200K, compaction fired at 151K; fixed via `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000` (applies only to models not in the CLI's built-in table; Claude models unaffected) | Installer sets this env for mapped models; document that it does not affect Claude models. |
| proxenos sends only the 7-day quota window, so the app shows a "weekly limit" banner | Quota reporting must mirror the shape Anthropic returns. |
| After a reboot the router listened 4 minutes after login (26s of it between exec and `listen()`), and for that whole window Claude Desktop was a blank page with `ERR_PROXY_CONNECTION_FAILED` — in picker mode every byte the app sends goes through us, so a router that is merely slow reads as an app that is broken (2026-09-14 09:59 boot → 10:15:59 listening) | The launchd agent is `ProcessType=Interactive`, never `Background` (that key throttles CPU and I/O — launchd.plist(5)). `listen()` comes before certificate minting and any other startup work, so a client waits rather than being refused. Every startup logs its budget (`startup Nms: node …, config …, listen …`). |
| "Start Router" ran `launchctl kickstart -k`, which kills a router that is already coming up and starts the wait over (three runs in the four minutes after login, 2026-09-14) | Starting is idempotent: a running agent is left alone, an unloaded one is re-bootstrapped. Only `restart` may force. |
| With the router down, the tray app's window loaded the router-served GUI and showed the same blank page as Claude Desktop — nothing anywhere said why | The app owns an offline notice that names the cause, keeps a login item so it is there before Claude Desktop is, and posts a notification when the router has been down for 20s. |
| Windows: the scheduled task inherited the console that started it, so closing the installer window killed the router with `0xC000013A` (Ctrl+C), 2026-09-14 | The task runs a PowerShell launcher that uses `Start-Process -PassThru -Wait`: detached from any console, still tracked so `RestartCount` keeps acting as KeepAlive and the exit code (including the health self-exit 75) propagates. |
| Windows: `install` registered a logon-triggered task and stopped there, so the router did not exist until the next sign-in — launchd starts at bootstrap (`RunAtLoad`) and the difference was invisible | `install` starts the supervisor itself on both platforms and prints the result. |
| Windows: trusting the CA failed with "this operation cannot use the UI" — every PowerShell call carried `-NonInteractive`, and the confirmation dialog never appeared, so picker mode stopped with no certificate and no explanation | Certificate trust and removal run WITHOUT `-NonInteractive` (and without `windowsHide`). They are UI operations by design: the OS must be able to show the user what it is being asked to trust. |
| Windows: sign-in failed with `missing_required_parameter` because the OAuth URL was opened via `cmd /c start`, and cmd reads `&` as a command separator — everything after the first parameter was cut off and run as commands (2026-09-14) | Browsers are opened with `Start-Process <url>` as a single quoted argument. Any URL we hand to a shell must survive its metacharacters. |
| The provider form's "also show in the Claude app picker" box only records `cli.extraModels`; picker mode itself stayed off, nothing was injected, and the user believed the picker was on (Windows x64, 2026-09-14: `config.json` had no `picker` key, no CA, no Config Library) | When that box is ticked while picker mode is off, the form says so under the box and offers to turn picker mode on right after saving. Any control that *looks* like it enables picker mode must either enable it or say what is still missing. |
| A DeepSeek mapping answered `401` on every real request while the provider form's own "Test connection" stayed green — the test sends the provider's headers alone, live traffic also carried the caller's `authorization` (2026-09-15, Windows) | A routed request carries provider authentication only (§4). The connection test and live traffic must present the same auth set, or the test certifies a path nobody uses. |
| Mapping Haiku 4.5 did nothing: the app sends `claude-haiku-4-5-20251001` while the GUI only offers the undated `claude-haiku-4-5`, and route lookup was an exact key match, so the request passed through and Haiku answered itself (2026-09-15) | Route lookup accepts both the dated and undated form of a model id. A mapping the GUI offers must be one the router can actually match. |
| The native `anthropic` provider (ingress-only) was offered as a mapping target and could be given picker entries; a slot pointed at it made every Claude request fail with `400` (2026-09-15) | Ingress-only providers never appear as mapping targets and create no picker/direct rules. A rule that names one is ignored at resolve time, so an existing config degrades to passthrough instead of failing. |
| Windows: "Connect Claude subscription" always failed with "Claude Code CLI not found" — discovery looked for an extensionless `claude` on PATH and for the macOS Application Support cache, neither of which exists there (2026-09-15) | Launcher discovery is per-platform: `.exe`/`.cmd`/`.bat` names on Windows, both AppData roots for the Desktop-cached CLI, and a shell for the `.cmd` launcher that cannot be spawned directly. |
| Closing Claude Desktop's window does not quit it; reopening hits `Not main instance, returning early` and the app silently keeps the OLD proxy setting. The user sees "I configured it and nothing happened" with no error anywhere (2026-09-14) | Tell the user that closing the window is not enough, and detect it: with picker mode on, the router knows whether the app is actually routing through it. Surface "configured, but the app has not restarted yet" rather than letting it fail silently. |

## 6. Blocked paths (measured, do not retry)

- The app puts `ANTHROPIC_BASE_URL` in the CLI process env directly;
  `settings.json` env does not override an existing variable; project-scope
  `.claude/settings.local.json` env is ignored for base URL.
- `ANTHROPIC_UNIX_SOCKET` does not apply.
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set only in 3P/Cowork.
- 3P mode is all-or-nothing at app launch and loses connectors.

## 7. Competitive position (2026-09-11)

Six repos target the app (ModelLink 135★ best); all use the official gateway
setting and pay its costs (§2). Four are Chinese-market only; ModelLink is
CC BY-NC-ND (no forks, no sponsors). CLI-targeting `claude-code-router` has
37,180★, `opencodex` 14,300★ with two README sponsors. Open positions: English
distribution, GPL-3.0 license (chosen 2026-09-13 over MIT: sole author, reversible later, blocks closed commercial repackaging), sponsor slots. Positioning: an **add-on for Claude
subscribers**, not a replacement for people without one.
