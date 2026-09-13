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

## 4. Provider adapters

- **Anthropic-compatible providers** (DeepSeek, Kimi/Moonshot, GLM, MiniMax and
  others expose `/v1/messages`): host + model rewrite only, no translation. This
  is the whole reason `claude-code-router` works with just `ANTHROPIC_BASE_URL`.
  **(assumption — verify each provider's endpoint before shipping a preset.)**
- **ChatGPT subscription (Codex backend):** needs a translation layer,
  Anthropic Messages ⇄ OpenAI Responses, plus OAuth (PKCE) login against
  `chatgpt.com/backend-api/codex`. The upstream endpoint is unofficial and may
  change.
  - Reference implementations, used as **behavioral specs only, no code copied**:
    [husniadil/proxenos](https://github.com/husniadil/proxenos) (Rust, Apache-2.0;
    measured cache hit 97.8–98.7% in daily use) and
    [insightflo/chatgpt-codex-proxy](https://github.com/insightflo/chatgpt-codex-proxy)
    (TypeScript, MIT; OAuth, tool calling, SSE).
  - Cache is the make-or-break metric. An earlier translator (opencodex) lost
    `cache_control` breakpoints and re-signed reasoning, giving 12–20% cache
    hit and 8× input token spend. **Acceptance: ≥90% cache hit on a
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
distribution, MIT license, sponsor slots. Positioning: an **add-on for Claude
subscribers**, not a replacement for people without one.
