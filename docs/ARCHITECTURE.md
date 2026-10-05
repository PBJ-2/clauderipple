# ClaudeRipple — Architecture and verified facts

Last verified: 2026-09-20 against Claude Desktop 1.52386.0, Claude Code CLI 2.1.275.
Everything below is backed by a document, a file, or a measured log. Items marked
**(assumption)** are not.

## 1. The mechanism

```
~/.claude/settings.json
  env.HTTPS_PROXY         = http://127.0.0.1:<port>
  env.NODE_EXTRA_CA_CERTS = <state dir>/ca.pem

CLI: CONNECT api.anthropic.com  → ClaudeRipple terminates TLS (leaf cert signed by ca.pem)
     per request, in order:
       direct rule (prefix)   → send to that provider, model unchanged (+effort)
       slot alias (routes)    → rewrite model (+effort), send to provider adapter
       exactly one provider's
         own `models` carries
         the id               → send there, model unchanged (see "declared models" below)
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

### Optional Auto mode classifier target

`autoModeClassifier: { provider, model, effort }` selects the inference target for
Claude Code's tool-free security-monitor system requests. It is opt-in: without
this setting, native routing remains unchanged. For example:

```json
"autoModeClassifier": {"provider": "codex", "model": "gpt-6-luna", "effort": "low"}
```

The named provider must exist and support outbound inference. Detection uses the
security-monitor system prompt, never user messages or routing markers. The
original security prompt, context, output format and native decision logic remain
intact. Configure this field in the JSON config; the settings GUI has no control
for it yet. Removing the field restores ordinary routing.

This request is Auto mode's safety check: it decides whether an action the agent
wants to take runs without asking. A target that judges worse than the model
Claude Code chose lets more through, and nothing reports it, since an allowed
action looks like any other. Choose the target for its judgement, not for its
quota. Matching keys on the classifier prompt's opening sentence; if a Claude Code
release rewords it, the requests stop matching and go back to the native
classifier, which is the safe direction to fail in.

Verified with Desktop's Claude Code 2.1.284: both classification stages used the
configured target; an authorized temporary-file write proceeded and an explicitly
forbidden deletion was denied. The registered `CLAUDE_CODE_AUTO_MODE_MODEL`
environment variable did not change the actual native classifier requests.

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
- The CLI is **not** the unchecked link the sentence above might suggest: it does
  classify the id, and an id it does not know produces a stderr line
  `[claude-code:unrecognized_model] {"model":"…","query_source":"…"}`. That
  classification is a **signal only** — the request still goes out with the custom
  id. Measured 2026-09-19 on 2.1.272:
  `claude --model muse-spark-1.3-contributor@medium -p "…"` printed the warning
  and the router logged
  `muse-spark-1.3-contributor@medium -> muse-spark-1.3-contributor  out=22`, i.e.
  the id reached the provider unchanged. The same `unrecognized_model` path exists
  in 2.1.268 and 2.1.270, so this is not new behaviour. Two consequences for us:
  picker mode keeps working, but the warning is noise users will report, and the
  classifier is a place where a future release could start rejecting rather than
  warning — worth re-measuring on each CLI bump.
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
- **The effort menu is per entry.** The Code tab reads each model's own
  `thinking.effort_options` (ids from `low/medium/high/xhigh/max`; an option may
  carry `recommended`, which the app falls back to when the selected level is not
  listed) — read from the app's cached web bundle, 2026-10-02. A cloned Claude
  entry therefore offered Claude's ladder for every routed model; the injected
  entry now keeps only the template options whose id the model's ladder holds,
  recommends high (or the nearest), and drops `thinking` when none remain. The
  real bootstrap's option fields beyond `id`/`recommended` were not captured.
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

- **Declared models route themselves (2026-09-19).** A provider's `models` list —
  filled by the probe from the vendor's `/models`, ticked in the GUI — now decides
  routing when no rule matched: a model exactly one provider carries goes there,
  unchanged. Before this, that list was display only, so ticking a model in the GUI
  did nothing until a `direct` rule was also written by hand; one live config had
  eighteen such rules, and seventeen were exactly this case. Rules keep their
  priority, so this only fills the gap they leave — measured against that config,
  **nothing that routed changed** and three models that had been ticked but were
  falling through to Anthropic (`deepseek-flash`, `moonshotai/kimi-k3`,
  `z-ai/glm-5.3-flash`) started working. Two constraints make it safe to have as a
  default: an id **two** providers carry is left to the operator (`deepseek-v4-pro`
  is on both a direct DeepSeek mapping and OpenCode Go, and they are not the same
  deal), and an **ingress-only** owner is not a target — the native `anthropic`
  provider lists the Claude models, and routing those would have done the §5 400 to
  a whole session without anyone writing a rule. An ingress-only owner still counts
  as an owner, so a third party also offering `claude-opus-5` reads as an ambiguity
  to ask about rather than a silent redirection of Claude traffic.
  Prefix rules stay useful for what no provider declares yet (`gpt-` catches a model
  released today). A model reaching a provider this way carries no per-model context
  window unless it is also in `cli.extraModels` or a slot — the same as a direct rule.
  - **The GUI stopped writing a rule per ticked model** at the same time, since ticking
    one is no longer what makes it route. It writes one only for an id more than one
    provider offers, and keeps an existing one for such an id **even when nothing ticks
    it** — `deepseek-v4-pro` is in no picker list and dropping its rule would have
    stopped it routing. Simulating one save on the config above: 18 direct rules → 2
    (`gpt-` and `deepseek-v4-pro`), picker entries unchanged at 5, and **no model
    resolved anywhere different**. Picker exposure stays what the operator ticked; it is
    routing that stopped needing to be said twice.
- **Worker definitions derive from the same list (2026-09-20).** A ticked model is
  also a subagent the operator can name: for every id exactly one non-ingress
  provider declares, the router writes `~/.claude/agents/<name>.md` (`agents.ts`;
  `name` = the id with anything outside `[a-z0-9-]` folded to `-`, frontmatter
  `model:` = the exact id, `@high` when the provider offers any effort level —
  `@medium` until 2026-10-02). It
  records what it wrote in `<home>/generated-agents.json` and touches **only**
  those files: a hand-written agent of the same name wins and is left alone, an
  unticked model removes its generated file and nothing else, identical content is
  not rewritten. `cli.agentFiles: false` turns generation off;
  `cli.limitWorkerTools: true` adds a `tools:` line so a worker does not inherit
  every MCP and plugin tool of the session (first request 32,942 → 8,823 tokens,
  2026-09-29), at the cost of browser and simulator tools. It is opt-in for that
  reason. With a chatgpt provider configured the body also tells a worker how to
  make an image: `POST /api/image` on the admin port, which runs one Codex
  Responses turn with the hosted `image_generation` tool required and answers
  with the image bytes (`clauderipple image` is the same call). Measured
  2026-09-29 on a subscription: the image is the `image_generation_call` output
  item's base64 `result`, about 30 s; `output_format` and `background` are
  honoured, `size` and `quality` are accepted and ignored (even "999x1" and
  "bogus" returned 200), and the shape follows the prompt ("square composition"
  → 1254x1254). So the API takes `aspect` and says it in words. The marker alias
  table is the union of `aliases` (explicit, wins) and every agent file's
  `name → model` — so `[[ripple: <agent>@<effort>]]` resolves for any agent that
  exists, generated or not, with no second registry to keep in step. Why: on
  2026-09-20 a hand-written agent named `deepseek` had no matching alias; the
  marker `[[ripple: deepseek@high]]` therefore named a model nobody declared, and
  thirty requests went to Anthropic as `PASS` and came back 404 (§5).
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
    rejected (luna accepts it). Clamp `ultra` → `max`. **Conflicts with the
    catalogue (2026-09-23):** the Codex model catalogue now lists `ultra` for
    gpt-5.6-terra/sol, gpt-6-astra/sol and *not* for either Luna. Not
    re-measured — the subscription's weekly quota was at 100% that day. The
    global `effortClamp` (`ultra → max`) means no `ultra` is sent either way, so
    only the GUI's ladder follows the catalogue; re-measure before removing the
    clamp. Measured the same day on the OpenAI API side (OpenCode Zen
    `/zen/v1/responses`, not the Codex backend): gpt-6-sol, gpt-6-luna,
    gpt-5.6-sol and gpt-5.6-luna all accept `none, low, medium, high, xhigh,
    max` and answer `400 param: reasoning.effort` to both `minimal` and
    `ultra`. So `ultra` is not a level that API takes on any of them; whether
    the Codex backend does is still open.
  - **Model catalogue (2026-09-23).** `GET {base}/codex/models?client_version=<v>`
    with the same credentials answers `{ models: [{ slug, display_name,
    visibility: "list"|"hide", context_window, supported_reasoning_levels:
    [{effort}] }] }` — what the Codex CLI's picker shows. **The server filters by
    `client_version`:** `0.146.0` omitted gpt-6-astra/sol/luna, `0.155.0`
    listed them. The adapter (`catalog.ts`) asks with the higher of a floor and
    `~/.codex/models_cache.json`'s `client_version`, drops `hide` entries, keeps
    the list an hour, and falls back to a measured list in the same file. The
    GUI's ChatGPT form fetches it on open; new models arrive unticked. Model ids
    unknown to the backend answer `400 "… model is not supported when using
    Codex with a ChatGPT account"` before any quota check, so a `429` for
    gpt-6-sol/luna that day confirmed the ids without spending quota.
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
    adapter reads both. Headers only arrive with traffic, though, and on a quiet
    day the admin status sat at `1%` for eleven hours while the real figure was
    `39%` (2026-09-20). So the adapter also **asks**: `GET
    https://chatgpt.com/backend-api/wham/usage` with the same credentials (the
    Codex CLI's own path — `/api/codex/usage` is a documented alias that answers
    403 to us; measured), a JSON body whose windows are in seconds, mapped to the
    header shape. `/api/status` refreshes when the snapshot is over 10 minutes
    old or on `?refresh=1`, shares one in-flight lookup, and marks the answer
    `stale: true` with a reason when the lookup fails rather than hiding the old
    value. Once at startup too, after `listen()`, never awaited.
  - **Several accounts (2026-09-24, `chatgpt/accounts.ts`).** Behaviour taken
    as a spec from opencodex's Codex account pool (no code). `clauderipple
    login` adds an account; the authorize URL carries `prompt=login` and
    `id_token_add_organizations=true`, since without `prompt=login` the browser's
    existing ChatGPT session is reused and "add another" returns the one already
    added. Identity is `chatgpt_account_id` + email (one person can be in several
    workspaces with separate limits; several people can share a workspace);
    the same pair signing in again replaces its entry. Store:
    `<home>/chatgpt-accounts.json`, 0600, cross-process lock, atomic write; the
    pre-pool `chatgpt-auth.json` is read as account `legacy` and retired on the
    first durable write. The Codex CLI's `~/.codex/auth.json` login joins last
    (mode `auto`), read-only, never refreshed. Refresh is per account,
    single-flight per token generation, five minutes ahead; only a structured
    `invalid_grant` / `refresh_token_invalidated|expired|reused` code marks an
    account for sign-in (prose only when no code, only on 400/401) — a 5xx
    mentioning "revoked" must not retire a working account. Per turn: the
    conversation's account while usable (the shared CredentialPool, keyed by
    owner so a refreshed token keeps it); before any byte reaches the client,
    429/402 rests that account until `retry-after`, else the latest reset among
    its full `x-codex-*` windows, else primary reset-after; 401 (or a 403 that
    reads as auth) gets one refresh and a replay, and a fresh token refused again
    marks it for sign-in; 5xx/no connection rests it briefly; other 4xx are the
    request's fault and go no further. A 200 whose headers report a window at
    100% rests the account before the next turn can fail. `x-codex-turn-state`
    is kept per (account, conversation). `/api/status` keeps `chatgpt.quota` as
    one snapshot (the account that answers next — the tray and other readers
    want one number) and adds `chatgpt.accounts` per account; `/wham/usage` is
    asked for every account.
  - **The prompt cache is keyed on the conversation's identity, not on
    `prompt_cache_key` (since mid-September 2026).** Five turns with byte-identical
    instructions, tools and input prefix, 3–6s apart under one key, all came back
    `cached_tokens: 0` and `cache_write_tokens: 0` (measured 2026-09-20 on GPT-6
    Astra; the same adapter read 93% on 2026-09-13, 9% that day). The Codex CLI got
    99.8% the same afternoon. Its request, captured through a local reverse proxy
    (`chatgpt_base_url`, websockets off) and bisected against ours: a **stable
    per-conversation id** in `session-id`/`thread-id`, in `x-client-request-id`, or
    in body `client_metadata` turns the cache on — any one of them; `x-codex-turn-
    metadata` alone does not, nor does echoing `x-codex-turn-state` alone, nor a
    UUID-shaped `prompt_cache_key`. The adapter now sends the CLI's set: the four
    headers, `client_metadata` (`session_id`, `thread_id`, fresh `turn_id`,
    `x-codex-window-id`), `prompt_cache_key` as the same UUID, and the previous
    answer's `x-codex-turn-state` echoed back. All derive from `conversationKey`,
    so cache, credential stickiness and identity name one conversation. Measured
    after: turn 2 at 83.6%, turns 3+ at 99.6%.
  - **Tool schema scrub.** The backend validates every `pattern` in
    `tools[].parameters` with a regex engine that rejects lookaround and
    backreferences, and one bad pattern fails the whole request with 400
    `invalid_function_parameters` ("… is not a 'regex'"). Claude Code's
    `Artifact` tool carries `^(?!__.*__$)…` since ~2.1.266, which broke every
    GPT request through proxenos as well. `normalizeSchema` drops such patterns
    (the client validates its own inputs). Upstream error bodies are now logged.
  - **Tool name constraint.** A Responses function name must match
    `^[a-zA-Z0-9_-]{1,64}$`, and one name that breaks it fails the whole request,
    not just that tool. Claude Code names MCP tools `mcp__<server>__<tool>` and a
    claude.ai connector's server name is a UUID, so the prefix alone eats 43
    characters: over-long names are routine, not exotic (measured in this
    session's own tool list, 2026-09-17; reported as issue #1). The name is
    therefore mangled on every outbound site — tool declarations, `tool_choice`,
    and the `function_call` of a replayed assistant turn — and restored in the
    inbound `function_call` handler, because the model echoes the name it was
    given and Claude Code matches `tool_use.name` against its own tool list.
    `toolNameForResponses` keeps the first 55 characters of the sanitised name
    and appends `_` plus 8 hex of sha256(original); every mangled name carries
    the hash, so two names that sanitise alike (`a.b`, `a-b`) cannot collide.
    A name already inside the constraint is returned untouched, so a session
    without MCP tools produces byte-identical output and the cache prefix does
    not move. The same constraint and the same helpers apply to the
    `openai-compatible` adapter (§4c).
  - **Server tools are dropped, on every translated path.** `web_search` and its siblings arrive
    as `{ type: "web_search_20250305", name: "web_search", max_uses: N }` with no `input_schema`.
    They are run by Anthropic, not by the model holding them, so declaring one to a translated
    provider offers a tool that cannot execute: the model calls it, nothing answers, and the turn
    returns empty with no error. `compat.ts` has dropped these on the anthropic-compatible path
    from the start; the ChatGPT and openai-compatible translators do the same, and a `tool_choice`
    that named a dropped tool is dropped with it. The adapter logs each drop by name, because the
    failure it replaces is silent.
  - **A dropped server tool's instructions are withdrawn too (issue #47).** The advisor does reach
    adapters: Claude Code 2.1.286 declares `{ type: "advisor_20260301", name: "advisor", model }`
    on every subagent whatever its `tools:` list says, and explains it in an `isMeta` user message
    (`# Advisor Tool`, "call advisor BEFORE substantive work"). Measured 2026-10-04: `dropped server
    tools for gpt-6-astra: advisor` on every worker request, and 26 of 28 routed worker transcripts
    reporting the tool missing. Dropping only the declaration leaves an instruction the model cannot
    follow. Each translated path that drops server tools therefore appends one line after the
    caller's system text naming them and telling the model to disregard instructions to call them
    (`droppedServerToolNote`), the same move the CLI makes when it removes the advisor itself ("The
    advisor tool is no longer available; disregard the earlier advisor instructions."). The CLI's
    wording is not matched or stripped, since it changes between releases. Names are sorted, so one
    set yields one byte sequence and the cached prefix holds. An anthropic-compatible provider with
    `serverTools: true` keeps every server tool and gets no line; whether DeepSeek runs `advisor` is
    unmeasured.
  - **Where web search actually runs (measured 2026-09-17).** Claude Code does not put `web_search`
    in the main request. `WebSearch` opens a *separate side request* — system prompt "You are an
    assistant for performing a web search tool use", one message "Perform a web search for the
    query: …", the server tool forced by `tool_choice`, `max_uses: 8` — and sends it to
    `H("tengu_plum_vx3") ? Og() : mainLoopModel()`. That gate is on: an Opus 5 session and a
    DeepSeek-routed session both sent it to `claude-haiku-4-5-20251001`, byte-for-byte the same
    request (11,208 input tokens for an identical query), which passes through to Anthropic and
    never reaches an adapter. A control run without a search produced no such request. So today a
    routed model never sees a server tool — **and the model driving the search is Haiku for every
    session, Claude or routed.** The routed model still chooses the query and reads the results;
    only titles and URLs survive the hand-back (snippets are dropped in the CLI), plus the search
    model's prose. The gate is Anthropic's to flip, which is why the drop above exists.
  - **Some providers run the search themselves — ask them, do not read about them.** DeepSeek's
    Anthropic endpoint executes `web_search_20250305` server-side. Its API documentation does not
    say so, and a docs check concluded twice that it could not; sending the tool to
    `api.deepseek.com/anthropic` returned `server_tool_use`, a `web_search_tool_result` holding ten
    hits, and `usage.server_tool_use.web_search_requests: 1` (2026-09-17). The blanket server-tool
    drop was therefore destroying a capability the user was already paying for, invisibly. The drop
    is now gated on `caps.serverTools`, set per preset from a measured reply only.
    - With that, and `ANTHROPIC_SMALL_FAST_MODEL` pointed at the routed model so the side request
      reaches the provider at all, a whole `deepseek-flash` session — search included — ran with
      **zero** Anthropic calls of any kind, title generation included. No interception, no second
      vendor, no translation: the provider the user pays for does its own search.
    - **Model slots (`cli.models`).** Claude Code fixes its own model choices before a request
      exists, so routing cannot reach them; they are environment names written into
      `~/.claude/settings.json` on install, alongside the proxy entries:
      `main` → `ANTHROPIC_MODEL`, `smallFast` → `ANTHROPIC_SMALL_FAST_MODEL`,
      `subagent` → `CLAUDE_CODE_SUBAGENT_MODEL`. Each is left alone when unset, so nothing changes
      until one is chosen, and `removeProxyEnv` always takes all three back — a slot still pointing
      at a routed model after uninstall would send every search and subagent to a router that is no
      longer there. The GUI offers them on the Clients screen rather than leaving them to
      `config.json`, because they are the difference between a session that costs Claude quota and
      one that does not.
      - **A GUI save writes them too.** `PUT /api/config` writes only `config.json` — the router
        hot-reloads that on mtime — but nothing about the router can apply a slot, since the CLI
        reads it before a request exists. So the handler calls `syncModelSlots` and returns a
        `warning` the GUI has to show. Writing them on install alone was the bug (2026-09-21): the
        Clients screen saved `smallFast: deepseek-v4.1-flash` into `config.json`, the screen showed
        DeepSeek, and every search, title and classifier went on running on Haiku because
        `env.ANTHROPIC_SMALL_FAST_MODEL` was never written. `syncModelSlots` is additive — a slot
        the config does not name is left as it is, so a GUI save cannot undo a hand-set one — and it
        refuses to write when `env.HTTPS_PROXY` belongs to another proxy.
      - **The screen says which models the router cannot search through** (2026-09-21). A slot
        pointed at such a model makes every `WebSearch` a visible failure, and nothing on the screen
        warned. `GET /api/status` marks each provider with `webSearch: true` when the router could run
        a search there, and the Clients screen appends "no web search here" to every `smallFast`
        option without it. The flag answers *can the router search here*, not *can this model
        search* — those differ, and the difference was measured: OpenCode Go's **Responses** endpoint
        runs OpenAI's hosted `web_search` and cites real pages, but its wire is OpenAI-shaped while
        its hits arrive as Responses events (`web_search_call`, `url_citation`), a backend the router
        does not have. DeepSeek's own endpoint and the ChatGPT provider run Anthropic's server tool;
        OpenCode Go's chat and Anthropic endpoints, and every `openai-compatible` provider, do not.
    - **A model that cannot search does not merely decline — it invents.** Measured 2026-09-21
      against OpenCode Go's chat endpoint: `plugins: [{id: "web"}]` is accepted and ignored (HTTP
      200, no `annotations`, cache reporting no lookup), and the model answers a search-shaped
      request with a confident answer built from plausible URLs. Pointed at an obscure query it
      admits it ("There's no tool for web search provided"); pointed at a common one it does not.
      This is why the router refuses such a side request instead of forwarding it — an answer shaped
      like success, holding nothing, is worse than a visible failure.
    - This is the preferred path wherever it works. `cfg.webSearch` below is the fallback for
      providers that cannot, and for the translated paths, where the tool is not passed through but
      converted.
  - **Serving the search ourselves (`cfg.webSearch`, 2026-09-17).** Because the search runs on a
    Claude model, a routed session still cannot search without Claude quota — the product is only
    half routed. With `webSearch: { provider, model }` set, the router recognises the side request
    and answers it from that provider's own hosted search, and no model call leaves for Anthropic.
    Verified end to end: a `deepseek-flash` session searched and got real results with **zero**
    Anthropic `/v1/messages` calls in the log, the only `PASS` line being the intercepted search
    itself. It needs no env var — we terminate TLS for `api.anthropic.com`, so the side request
    passes through whatever its model id, and the interception sits ahead of routing.
    - The fingerprint is **one declared tool, the `web_search` server tool, and one user message
      that is the CLI's fixed sentence**. A forced `tool_choice` is deliberately *not* required:
      the CLI source passes `toolChoice: {type:"tool", name:"web_search"}`, but the wire carries
      `{"type":"auto"}` (measured). Reading the source alone got this wrong once.
    - OpenRouter runs it as `plugins: [{id:"web"}]` on Chat Completions and answers with
      `annotations[].url_citation` (`title`, `url`); the side request's `allowed_domains` /
      `blocked_domains` map to `include_domains` / `exclude_domains`. Measured live: four
      citations, $0.0073 for the call.
    - **ChatGPT subscription search (implemented and live-verified 2026-09-20).** A `chatgpt`
      provider uses the same `CredentialStore` and Codex Responses endpoint as ordinary turns,
      with `tools: [{type:"web_search", search_context_size:"low",
      external_web_access:true}]` and `tool_choice:"required"`. The measured stream carries a
      `web_search_call`, `url_citation` annotations, and
      `response.completed.response.tool_usage.web_search.num_requests`. The adapter requires both
      a real search count and at least one citation; it never turns uncited prose into a successful
      result. `allowed_domains` becomes `filters.allowed_domains`. Codex exposes no corresponding
      exclusion filter, so `blocked_domains` is refused rather than ignored. This path is opt-in
      through `webSearch: {provider, model}`; with no setting, Claude Code's existing Haiku search
      path is unchanged.
    - The reply is assembled as `server_tool_use` + `web_search_tool_result` + `text`, with
      `usage.server_tool_use.web_search_requests` — the field the CLI turns into "Did N searches".
    - A provider that runs the tool itself is asked in Anthropic's own shape instead
      (`anthropicServerToolBackend`): the same side request, relayed, with the hits read back out
      of its `web_search_tool_result`. No translation, no agent loop — opencodex needs a loop only
      because its backends cannot be handed a server tool directly (§4 of OPENCODEX).
    - **A side request routed where the tool cannot run is refused, not sent.** Recognising the
      search does not depend on `webSearch` being configured — it is the unconfigured router that
      most needs the guard. The reply is `web_search_tool_result_error: unavailable` with
      `web_search_requests: 0`, so the CLI reports a failed search instead of printing invented
      prose. This was found the hard way: a stale `ANTHROPIC_SMALL_FAST_MODEL` left in a running
      session kept sending searches to a provider that could not run them, and the session reported
      the search tool as unresponsive with nothing in any log to say why.
    - **The backend is chosen by how the provider is spoken to, not by vendor.**
      `anthropic-compatible` → server tool, `openai-compatible` → web plugin. Anything else refuses
      and leaves the request alone.
    - An `anthropic-compatible` provider whose `serverTools` capability is false is **refused before
      the request is sent**. This is not caution: dropping the server tool leaves a request that
      says "you are an assistant for performing a web search tool use / perform a web search for the
      query: …" **with no tool attached**, and a model told to search with nothing to search with
      narrates a tool call instead. OpenCode Go's DeepSeek answered exactly that — its own
      `<｜｜DSML｜｜ invoke name="web_search">` markup as plain text, zero searches, HTTP 200
      (measured 2026-09-18). Same vendor as the DeepSeek that does run it; different route.
    - A backend that returns no citations, or no result blocks, **throws**, and the request falls
      through to the ordinary path. A search that quietly returns nothing is the one outcome worth
      avoiding, since nothing anywhere reports it.
    - The search model iterates: a single `WebSearch` can produce several side requests with
      refined queries, each intercepted on its own.
  - `WebFetch` needs none of this: the CLI fetches the URL itself (its own transport, cache and
    preflight; there is no `web_fetch` server tool in the binary) and has the session's model read
    the text. It works on any provider.
  - Cache-safety decisions: thinking blocks are dropped from replayed history;
    no reasoning `include`; identity line and `instructionsAppend` are constant
    text; `prompt_cache_key` = sha256(metadata.user_id + first user message),
    and sha256(system prompt) for a request that carries no `metadata.user_id`
    and one lone user turn — see the conversation-key note in §4.

### 4c. What a routed model is told it is

- Claude Code's system prompt opens with "You are Claude Code, Anthropic's
  official CLI for Claude". A mapped provider receives that text and has nothing
  else to go on: asked what it was, DeepSeek answered that it was Claude while
  the session label read `deepseek-flash` (measured 2026-09-16).
- So every provider that assembles a system prompt puts one line in front of it:
  `You are <model> (reasoning effort: <effort>), answering through Claude Code, a
  terminal-based coding agent.` The effort is named because a model cannot see
  its own setting; it is omitted when the provider takes no reasoning effort.
  `packages/router/src/identity.ts` holds the sentence, and the ChatGPT,
  OpenAI-compatible and Anthropic-compatible paths all use it.
- On the Anthropic-compatible path the line is added **after** the compatibility
  pass, so the effort named is the one the provider actually receives. A string
  `system` stays a string; a block array gains a leading block that carries no
  `cache_control`, leaving the caller's breakpoints where they were.
- `identity: false` per provider turns it off; `instructionsAppend` adds fixed
  text after the prompt. Both are constant per provider, so the prompt cache
  misses once when either changes and not afterwards.

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
  from `create` requests before forwarding. An `anthropic-compatible` vendor holds no
  thread either and is refused the same way: forwarding the stripped delta sent DeepSeek
  (via Bailian) two orphan `tool_result`s and no task (measured 2026-09-24, CLI 2.1.280, #29).
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

- **Credential pools (`providers.<name>.credentials`, 2026-09-17).** A provider may hold several
  credentials, each a complete header set. The conversation keeps the one it is on while that one
  is healthy — moving it moves the prompt cache with it, and ≥90% cache hit is an acceptance metric
  — and only a failure moves it, including back to one that has recovered rather than to the head
  of the list. A 401 quarantines a credential, because rejected credentials do not heal; a 429
  cools it until the vendor's stated reset (`retry-after`, seconds or HTTP-date, or the Codex reset
  header), clamped to six hours; a 402 cools it for half an hour; a 5xx or a connect failure for
  ten seconds. **A 4xx that is the request's own fault is charged to nobody** — retrying a bad body
  against every credential burns the pool and still fails. State is in memory: a cooldown that
  outlived a restart would make restarting worse. A provider that declares no pool has exactly the
  credential it always had. A slot may also name `fallbacks`: when every credential of its provider
  is parked, the turn goes to the first fallback that has one, chosen **before anything is sent**,
  since failing over mid-turn would splice two answers together. With nothing usable anywhere the
  primary is kept, so the provider refuses rather than the router inventing a refusal.
  - Four things an independent review found, each of which had made it past the unit tests because
    each lived in the wiring rather than the state machine: the pool never heard about the ChatGPT
    or openai-compatible adapters, so those providers looked healthy forever and a slot pointing at
    one could never fail over; an empty header set went upstream when the pool had nothing ready,
    and the resulting 401 quarantined a credential that had done nothing; `upReq.destroy()` emits
    ECONNRESET (measured, Node 24.15), so **every cancelled turn was charged to the credential** and
    moved the conversation off it, costing the prompt cache the metric depends on; and a fallback
    naming a native `anthropic` provider re-opened the §5 row about ingress-only targets.
  - 403 does not quarantine. It is also a content policy, a blocked region, a model the account may
    not use, or an edge refusing what it took for a bot — parking a working credential until someone
    notices is the worse mistake. Only 401 parks.
  - An answer lifts a quarantine but does not cancel a live cooldown: requests overlap, and a 200
    arriving after a concurrent 429 does not mean the limit lifted.
  - The conversation key is `conversationKey`, the same one the prompt cache uses. `metadata.user_id`
    alone is one value for every conversation a user has, so using it raw dragged all of them onto
    one credential at once — the opposite of what stickiness is for.
  - The same key has a second branch, because not every request is a conversation. What the CLI
    sends *beside* one — the web-search side request, a title, a summary — carries no `metadata` at
    all and one lone user message that is different every time, so seeding on that message minted a
    new key per request: measured `cached_tokens: 0` on all 68 smallFast calls in a day's log, while
    Muse hit 97/129 and Opus 6,960/11,633 in the same log. It was not the endpoint — the same wire
    asked twice under one key returned 94% (2,304/2,441). So a request with no `user_id` and one
    message is keyed on its **system prompt**, which is the part of it that does not vary: every
    web search shares one key, every title another, and the fixed prefix each class sends is cached
    after the first. This is the acceptance metric (≥90% on translated providers), not a tidy-up.
    A real conversation that was merely never given metadata — the OpenAI ingress builds none — is
    keyed as before from its second turn on; only its opening turn, which is indistinguishable from
    a side request, joins the class key, and what it reads there is the prefix it sends anyway.
  - **A refused credential is replaced inside the same turn**, while nothing has been written to the
    client. The turn that discovers a limit used to be spent — the client got the 429 and retried it
    itself — and now the next credential answers on the first ask. Only before the first byte: after
    that the turn is committed, because replacing a half-sent stream splices two answers together.
    A credential is tried at most once per turn, and a failure that is the request's own fault is
    not retried at all, so a bad body cannot walk the whole pool.
  - Covered by `test/proxy-failover.test.ts`, which drives a real proxy rather than the state
    machine: rotation, the exhausted-pool header, the cancelled turn, failover, the ingress-only
    refusal, the same-turn retry, its stopping condition, and a 400 not being retried. Three were
    written before the code and confirmed red first; two more were confirmed by breaking the fix
    again afterwards.
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
  `routes`/`aliases`/`direct` logic as the proxy. Targets are
  `anthropic-compatible`, native `anthropic`, and (Responses only) `chatgpt`;
  `openai-compatible` is rejected.
- **Codex's own GPT traffic (2026-09-24).** This listener used to reject
  `chatgpt` targets because "Codex already has a native path" (decided
  2026-09-13). That left Codex's GPT turns outside the account pool, so an
  opencodex user who rotates ChatGPT accounts in Codex could not switch — the
  superset goal (OPENCODEX.md) overrules it. `clauderipple codex on` now also
  writes a marked root `openai_base_url = "http://127.0.0.1:<openaiPort>/v1"`
  (never over a user's own), which points Codex's built-in `openai` provider
  here while Codex keeps its ChatGPT sign-in (behaviour of opencodex's loopback
  injection, observed in its docs). A `/v1/responses*` request whose model is
  routed to a `chatgpt` provider, or is unrouted and GPT-named
  (`gpt-`/`codex-`/`o<digit>` or in a chatgpt provider's list), is **passed
  through unchanged** to `{base}/codex/responses[/compact]`: body bytes as sent,
  an allowlist of Codex's protocol headers (session, window, turn state/metadata,
  beta features, installation id, originator), and the account's
  `authorization` + `chatgpt-account-id` laid over them. The answer is relayed
  byte for byte with its `x-codex-*` headers. `GET /v1/models?client_version=`
  (Codex refreshing its catalogue) goes to `{base}/codex/models`. Account choice,
  rotation and cooldowns are the provider's pool (§4, ChatGPT accounts); a turn
  token Codex echoes is dropped when the conversation has moved to another
  account. Out of accounts (none, all resting, or the last one hit its limit on
  this turn), the caller's own `Authorization`/`chatgpt-account-id` is used
  once as sent — pointing Codex here never leaves it worse off. A WebSocket
  upgrade is answered 426 so Codex falls back to SSE.
- **Codex app model list.** `codex on` also points `model_catalog_json` at
  `~/.codex/clauderipple-models.json`: Codex's own `models_cache.json` entries
  plus ours. That file *replaces* Codex's list, so it must follow both sides —
  the router rewrites it when its config loads and when Codex's cache changes
  (checked once a minute; the app reads the catalog only at startup). With the
  first alone, gpt-6.1-sol (2026-09-30) reached Codex's cache but not the app.
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
  `~/.claude/.credentials.json`, (5) ClaudeRipple's own
  `<home>/claude-auth.json` setup-token file, then (6) OAuth accounts added to
  `<home>/claude-accounts.json`. The observed source retains only
  `Authorization`, `anthropic-version`, `anthropic-beta`, `user-agent`,
  `x-app`, `x-stainless-*`, and `anthropic-client-*` request headers and sends
  that exact set upstream. It is never persisted, logged, included in RequestLog
  or picker diagnostics, debug dumps, or any admin API response. Keychain/file
  reads are cached for 60 seconds; ClaudeRipple **never refreshes or writes**
  Claude Code's own credential. Expiry becomes OpenAI-style 401 `Claude Code
  login expired — open Claude Code once to refresh`.
- `clauderipple claude-login` (0.1.2) is ClaudeRipple's own browser sign-in:
  the OAuth authorization-code flow with PKCE (S256) against Claude Code's
  public client, exactly as Claude Code 2.1.271 does (read from its binary,
  2026-09-16): `https://claude.com/cai/oauth/authorize` →
  `https://platform.claude.com/v1/oauth/token`, scopes `org:create_api_key
  user:profile user:inference user:sessions:claude_code user:mcp_servers
  user:file_upload` (the refresh grant names the subscription scopes only).
  The older `claude.ai/oauth/authorize` answers "Invalid request format"
  (measured). The code returns to a loopback listener, port 54545 preferred
  and any free port otherwise (the authorize server accepts any localhost
  port); with `--manual` the redirect is
  `https://platform.claude.com/oauth/code/callback` and the user pastes
  `code#state` (or the redirect URL). State and PKCE verifier are per attempt; a callback
  with the wrong state is refused without ending the attempt; an attempt
  expires after 5 minutes. Each grant (access + refresh token, expiry) is stored
  only in `<home>/claude-accounts.json` (mode `0600`). The upstream account UUID
  is hashed before storage and used only to replace the same account on re-login;
  admin surfaces expose a local opaque id, label, optional email and health, never
  either token or the upstream UUID. The GUI drives the same flow through
  `POST/GET /api/claude-oauth` and `POST /api/claude-oauth/code`; another sign-in
  adds an account rather than overwriting an unrelated one. An existing OAuth
  grant in the old `<home>/claude-auth.json` remains readable and is migrated
  atomically on the first pool mutation. `--setup-token` keeps that old file for
  its terminal-only long-lived token path; `claude-logout` removes both stores.
  Wire facts are behaviorally measured (the reference implementations do the
  same flow); they are not an Anthropic guarantee, and reuse of one or multiple
  subscriptions is subject to Anthropic's terms and possible account restrictions.
- A native `anthropic` provider remains OpenAI-ingress-only unless it explicitly
  sets `accountPool: true`. With that flag and `auth: "claude-code"`, Claude
  Desktop/Code Messages requests stay unmodified except for the routed model and
  selected identity. The runtime pool is ordered current observed/env/Claude Code
  login first, then ClaudeRipple-owned accounts. A conversation is sticky to the
  account that answered so its prompt-cache prefix survives, including across that
  account's token refresh. Before response headers reach the client, 401, 429, 402
  and retryable HTTP failures such as 5xx may retry the same request on an untried
  account; request-shape errors such as 400 do not, and no failover occurs after a
  response starts. A 401 permanently marks only that stored token generation as
  needing re-login; 429 and transient failures cool down without deleting it. Refresh
  is per-account process-wide single-flight and persisted with compare-and-swap so a
  stale refresh or rejection cannot overwrite a newer sign-in. Credential health uses
  a token-generation runtime id while affinity and admin APIs use the durable local
  account id, so a fresh login cannot inherit an old quarantine or lose its cache claim.
  Retry replaces every previous identity header, and every sent
  secret is added to error redaction. The OpenAI ingress for Codex uses the same
  ordered projection only to choose one available credential; it deliberately does
  not rotate accounts or retry a turn.
- Readiness vs liveness (0.1.2): `/api/status.readiness` and `GET /readyz`
  (200 or 503 + `retry-after: 5`) list what stands between a request and a
  model: `settings` (Claude Code not pointed at us), `upstream` (consecutive
  connect failures), `picker-ca` / `picker-proxy` (picker mode without trust or
  the app proxy entry), `provider:<name>` (TCP unreachable). The tray shows the
  list in its detail line. A router that answers is alive; only an empty list
  means it is ready.
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
inspected 2026-09-13. The latter is not an Anthropic guarantee. Its published documentation is
surveyed in [OPENCODEX.md](OPENCODEX.md) — adapter wire behaviour, the patterns worth reusing, and
what we do not have yet — so that adding a provider does not start with reading it again.

### 4c. `openai-compatible` providers (implemented 2026-09-13)

- This adapter translates Anthropic Messages into either OpenAI **Chat Completions**
  (the default `wire: "chat"`) or stateless **Responses** (`wire: "responses"`),
  then maps SSE back into Anthropic `message_start`, content-block, `message_delta`,
  and `message_stop` events. It supports text, base64/URL images, function tools,
  tool results, non-streaming replies, and local `count_tokens` estimates.
- **A model may speak another wire than the rest of its provider.** One subscription can
  serve several protocols on one key and one catalog: OpenCode Go answers Responses,
  Chat Completions and Anthropic Messages models on the same plan, and its `/models`
  lists them together (measured 2026-09-18). `wire` and `url` sat only on the provider,
  so that one account had to be configured as three providers — a split the user saw in
  the GUI and had to repeat in every `direct` rule. A model entry now overrides `wire`
  (`chat`, `responses` or `anthropic`), `url` and `authHeader`, and `providerFor` in
  `config.ts` folds those into an ordinary provider at the moment a request's model is
  known, so every `provider.type` branch downstream works against one unchanged
  contract. A provider with no override for that model is returned by identity.
  `authHeader` names a convention rather than restating the key: the provider's own
  credential is re-sent under the header that model's wire expects, so there is one copy
  of the key to rotate. Each endpoint follows the API it imitates — an Anthropic-wire
  model wants `x-api-key` where an OpenAI-wire one on the same key wants a bearer. A
  config still written as three providers is folded on the way in and its `direct` and
  `routes` references follow; nothing is rewritten on disk, so it stays readable by an
  older router until the GUI saves it.
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
  Vendors that do not report that field keep their configured fallback. For the
  OpenCode presets (`opencode-go`, `opencode-zen`) a model's ladder comes from
  models.dev — the catalogue OpenCode's own client reads, whose `reasoning_options`
  states it — and its `provider.npm` puts that wire first; one request then settles
  the wire and catches a plan refusal. Asking every level instead took ~10 sequential
  requests per model (glm-5.3-flash 1m54s, upstream latency 0.5–25s per one-token
  request, 2026-10-02) and was less right: a 200 means "not refused", and
  glm-5.3-flash accepted seven levels where the catalogue lists `low`/`high`/`max`.
  A model the catalogue lacks, or a catalogue that cannot be fetched, is measured as
  before (`catalog.ts`, `capabilities.ts`). Chat wire
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

### 4d. `google` providers (implemented 2026-10-01)

Gemini is a translated provider, not an ingress-only one: it holds no server-side thread,
so a `thread:continue` is refused exactly as in §4c and the CLI resends a stateless
history. It routes by its declared models, its agent files are generated like any other
provider's, and a `web_search` side request aimed at it is refused, not sent. The
adapter lives in `packages/router/src/providers/google/` and separates translation
(`translate.ts`), the wire (`transport.ts`) and the signature store
(`thoughtSignatures.ts`) so Stage 2 (Antigravity Code Assist) is a new transport only.

Both modes are implemented: `api-key` (AI Studio) below, and `auth: "antigravity"` (Cloud
Code Assist) in its own subsection. No live key or Antigravity subscription exists in this
environment, so everything below is doc- and source-derived and **not measured** unless it
says otherwise:

- Stream endpoint `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
  the key on header `x-goog-api-key`, base default `https://generativelanguage.googleapis.com`
  (https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent).
- `systemInstruction` takes `{role:"user"|"model", parts:[…]}`; `contents` is the
  `user`/`model` turn list; a part is `{text}`, `{inlineData:{mimeType,data}}`,
  `{functionCall:{name,args}}` or `{functionResponse:{name,response}}`. The `role` of a
  `functionResponse` part must be `user` (https://ai.google.dev/api/caching#Content).
- Tools map to `tools[].functionDeclarations[].parametersJsonSchema` — a protobuf
  `Value` carrying a full JSON Schema, mutually exclusive with the legacy `parameters`
  (https://ai.google.dev/api/caching#FunctionDeclaration). We send `parametersJsonSchema`.
- A function name is at most 64 characters, must start with a letter or underscore and
  may contain letters, digits, underscores, dots, dashes and colons (same
  `FunctionDeclaration.name`); longer ids are mangled and restored as in §4c.
- `toolConfig.functionCallingConfig.mode` is `AUTO` / `ANY` / `NONE`; `ANY` may also
  carry `allowedFunctionNames` (https://ai.google.dev/api/caching#FunctionCallingConfig).
  Anthropic `tool` maps to `ANY` + `allowedFunctionNames`, `none` to `NONE`.
- Gemini 3 reasons with `generationConfig.thinkingConfig.thinkingLevel`
  (`minimal|low|medium|high`); Gemini 2.5 with `thinkingConfig.thinkingBudget`
  (0..24576 flash, 128..32768 pro; 0 disables) (https://ai.google.dev/gemini-api/docs/thinking).
  `output_config.effort` is clamped to the model family and to the provider's
  `effortLevels` when set. **(assumption)** Some samples spell the REST field
  `thinking_level` flatly; we emit the documented nested `generationConfig.thinkingConfig`
  shape.
- `usageMetadata` fields are `promptTokenCount`, `cachedContentTokenCount`,
  `candidatesTokenCount`, `thoughtsTokenCount`
  (https://ai.google.dev/api/generate-content#UsageMetadata). Input =
  `promptTokenCount − cachedContentTokenCount`, cache read = `cachedContentTokenCount`,
  output = `candidatesTokenCount + thoughtsTokenCount`.
- A `finishReason` of `STOP` closes as `end_turn` (or `tool_use` when function calls
  were seen); `MAX_TOKENS` as `max_tokens`; anything else as `end_turn` with a log. A
  stream that ends with no `finishReason` is the §5 stalled-upstream shape: it becomes a
  retryable `overloaded_error`, never a silent `end_turn`
  (https://ai.google.dev/api/generate-content#FinishReason).
- A wrong key answers `400` with `status: "API_KEY_INVALID"` (or a `401`/`403` whose
  body names the key); that maps to Anthropic `authentication_error` (401). `429
  RESOURCE_EXHAUSTED` maps to `rate_limit_error`, `5xx` to `overloaded_error`, other
  `4xx` to `invalid_request_error`. A bare `403` is read as a permission/region problem,
  not a bad key.
- `GET {base}/v1beta/models?pageSize=1000` (key on `x-goog-api-key`) lists
  `{name, displayName, inputTokenLimit, supportedGenerationMethods, thinking}` with a
  `nextPageToken`; only entries whose `supportedGenerationMethods` include
  `generateContent` are kept, `id` is `name` minus `models/`, and
  `contextWindow = inputTokenLimit`
  (https://ai.google.dev/api/models#method:-models.list).
- **thoughtSignature (Gemini 3).** A `functionCall` part on a reasoning model may carry a
  `thoughtSignature`, and a client replaying that call must return the same signature or
  the API rejects the turn ("Function call is missing a thought_signature in
  functionCall parts"). The store keeps signatures keyed by our minted `tool_use` id in a
  bounded LRU (10,000) and re-attaches them on replay; per-part for parallel calls, where
  Gemini signs only the first call of a step. On a turn with no cached signature at all (a
  router restart, a history another model wrote) the documented sentinel
  `skip_thought_signature_validator` goes on that turn's **first** call, Gemini 3 only. The
  guide calls it a last resort that costs model performance, so it is never added to a turn
  that has a real signature — the unsigned parallel calls of a healthy turn are normal
  (https://cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures, sentinel
  paragraph read 2026-10-01).

### 4d-ii. Google `auth: "antigravity"` (Cloud Code Assist) — implemented 2026-10-01

A Google subscription signed in through `clauderipple google-login`, streaming through the
Cloud Code Assist (CCA) backend, with several accounts rotating. Same translation as AI
Studio; only `transport.ts` differs. Accounts live in `<home>/google-accounts.json` (0600,
cross-process lock, atomic write, one account per email+project, a re-login replaces its own
entry), the sign-in in `login.ts`, the account pool and refresh in `accounts.ts`, and the wire
facts and model-id resolution in `antigravity.ts`. **Every wire fact below is taken from the
reference implementation opencodex (GitHub `lidge-jun/opencodex`, read 2026-10-01 as a
behavioral spec — no code copied; project rule) and is not measured live** — no Antigravity
subscription exists in this environment. Files are under `src/`:

- OAuth is Google's standard installed-app flow with PKCE S256. Client id
  `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`, secret
  `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` (public client values, overridable by env;
  `oauth/google-antigravity.ts:17-20`). Authorize
  `https://accounts.google.com/o/oauth2/v2/auth`, tokens
  `https://oauth2.googleapis.com/token`, userinfo
  `https://www.googleapis.com/oauth2/v2/userinfo`; scopes `cloud-platform`, `userinfo.email`,
  `userinfo.profile`, `cclog`, `experimentsandconfigs`; `access_type=offline`,
  `prompt=consent select_account`; loopback callback port 51121 preferred, path `/callback`,
  any free port otherwise (`google-antigravity.ts:21-35,177-196`). The token body carries the
  client id **and** secret and `code_verifier` (form-encoded).
- Project discovery: `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` with
  `{metadata:{ideType:"ANTIGRAVITY"}}`; without a project,
  `POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser` with
  `{tier_id:"free-tier", metadata:{ide_type, ide_name:"antigravity", ide_version}}`, polled up
  to 5 times, 2 s apart, until `done:true` (`google-antigravity.ts:97-137`). The project id is
  read from `cloudaicompanionProject | projectId | project[.id]`. A sign-in that finds no
  project fails rather than storing a credential that would fail every call.
- Request: `POST {base}/v1internal:streamGenerateContent?alt=sse` (non-streaming
  `:generateContent`), base default `https://daily-cloudcode-pa.googleapis.com`
  (`adapters/google.ts:1056-1160`; devlog `140.21`). Envelope
  `{ model, userAgent:"antigravity", requestType:"agent", project, requestId:"agent-<uuid>",
  request }`, where `request` is the standard Gemini body plus a nested camelCase
  `sessionId` (`adapters/google.ts:1145-1158`; `google-antigravity-wire.ts:53-77`). Headers:
  `Authorization: Bearer <token>` and `User-Agent: antigravity/ide/<ver> (os_type=…; arch=…;
  aidev_client; auth_method=oauth)` — the IDE client family is required, the backend 404s
  CLI-shaped UAs (`adapters/client-fingerprint.ts:44-65`). Response frames nest the standard
  Gemini payload under `response` (`adapters/google.ts:1281,1591-1596`).
- Model ids. CCA's wire ids carry the tier as a suffix (`gemini-3.8-flash-low`) or a
  `-tiered` rename (`gemini-3.7-flash-tiered`), while the picker shows a collapsed base id.
  Resolution, from `providers/antigravity-models.ts`: `gemini-3.8-flash` → its suffix per
  effort (`…-low/medium/high`, no `thinkingLevel` beside it — the suffix IS the effort);
  `gemini-3.1-pro` → `gemini-3.1-pro-low` / `gemini-pro-agent` with `thinkingLevel`;
  `gemini-3.7-flash` → `gemini-3.7-flash-tiered` with `thinkingLevel`; a `claude-*` id takes a
  `thinkingLevel` only (`resolveAntigravityThinkingLevel` clamps `xhigh/max/ultra`→`high`).
  CCA's own catalogue is `POST {dailyApi}/v1internal:fetchAvailableModels` with `{project}`,
  body `{models:{<wireId>:{maxTokens,…}}, agentModelSorts:[{groups:[{modelIds:[…]}]}],
  tieredModelIds:{flash:[…]}}` (`providers/quota/antigravity.ts:166-168`,
  `providers/antigravity-models.ts:489-560`); when it cannot be read we fall back to the
  static collapsed list (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-pro`,
  `gemini-3.1-flash-image`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`, context windows from CCA `maxTokens`).
- Claude models on CCA force `toolConfig.functionCallingConfig.mode = "VALIDATED"`; a client
  asking for no tools gets the declarations dropped instead (`adapters/google.ts:1109-1120`).
- **thoughtSignature.** The CCA path sends a real signature back on the exact `functionCall`
  the model signed and never adds the `skip_thought_signature_validator` sentinel (a fabricated
  signature is not "real"). opencodex filters a stored signature with
  `isLikelyRealThoughtSignature` (`google-antigravity-wire.ts:30-42`) to keep a foreign id
  (`toolu_…`, `call_…`) out of the signature field, which Antigravity 400s
  (`TYPE_BYTES`/Base64 decode failure). We do not need that filter: our store is keyed by the
  `tool_use` id we minted and holds only a `thoughtSignature` the vendor itself sent, so a
  foreign id is never placed in the field.
- **Accounts and credentials (§4 Credential pools).** A conversation stays on the account that
  answered while it is healthy (moving it costs the prompt cache); a refusal before any byte
  reaches the client moves the turn to the next account: 401 (or a 403 that reads as a
  credential refusal) gets one refresh and a replay, a fresh token refused with a 401 again
  marks the account for sign-in; 429/402 rest the account to its `retry-after` (or a default);
  another 403, 5xx or a connect failure rests it briefly; any other 4xx is the request's fault
  and is not retried. Refresh is per account, single-flight per token generation, five minutes
  ahead; only a structured `invalid_grant` marks an account for sign-in. Only the access token
  and the account email/project id are ever in memory; no token reaches a log or an API response.
- Session id and prompt cache. The real client puts a stable per-conversation id at
  `request.sessionId` so provider-side replay can associate a signature with the call that made
  it; instability loses it (`google-antigravity-wire.ts:62-88`). We derive it from the router's
  own `conversationKey` (sha256 → BigEndian uint64 masked to 63 bits, left-padded with `-`,
  CLIProxyAPI's `generateStableSessionID` shape). `requestId` is a fresh `agent-<uuid>` per
  request, so it does not enter the cacheable body prefix.
- **Terms.** Using Antigravity credentials from a non-Google client is against Google's terms
  (Antigravity terms §6; the Gemini CLI FAQ) and Google blocked a large number of such accounts
  in February 2026. The CLI prints this once before a sign-in and the sign-in API returns it in
  a `warning` field for the GUI; the wording states only the fact. ClaudeRipple is not
  affiliated with Google.
- Admin: `POST/GET /api/google-login`, `POST /api/google-login/code`, `POST
  /api/google-login/cancel`, `POST /api/google-logout`, `GET /api/google-accounts`,
  `PATCH/DELETE /api/google-accounts/:id`, and `POST /api/providers/probe` with
  `{type:"google", auth:"antigravity"}`. CLI: `clauderipple google-login` / `google-logout`.

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
| Tool names over 64 characters were forwarded to the Responses API unchanged, so a single connected MCP server — the product's own use case (§2) — failed every request of that turn (found by reading the source, issue #1, 2026-09-17) | Any name a translated provider sends is mangled into the provider's constraint deterministically and restored on the way back (§4). A translator must validate what it forwards against the wire it forwards to, not only what it builds itself. |
| Unknown-model context window defaulted to 200K, compaction fired at 151K; fixed via `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000` (applies only to models not in the CLI's built-in table; Claude models unaffected) | Installer sets this env for mapped models; document that it does not affect Claude models. |
| Server tools (`web_search`) were declared to translated providers as ordinary functions: a tool the model can call and nothing can run. Not observed live, because Claude Code currently routes its web search elsewhere (§4) — the failure was one server-side flag away, and its shape is an empty answer with nothing logged (issue #4, 2026-09-17) | A translator declares only what the provider can actually execute, and says in the log what it removed. A capability that silently disappears is worse than one that visibly fails. |
| Routed workers were told to call the `advisor` after its declaration was dropped: Claude Code explains the tool in a user message the router left in place, so 26 of 28 worker transcripts reported it missing, every turn (issue #47, 2026-10-04) | Removing a capability includes withdrawing what was said about it. A translator that drops a tool adds one stable line saying so, rather than editing the caller's text. |
| One context window was written to every routed model and every slot, because `cli.autoCompactWindow` is a single number while `auto_compact_windows` and `context_window_by_model` are per-model maps. Routed models do not share a window: set it high and the smaller model overflows before it compacts, set it low and the larger throws away most of its own (issue #2, 2026-09-17) | A window belongs to a model, not to the router. `CliModel.contextWindow` and `Route.contextWindow` win, then whatever the vendor's `/models` reported as `context_length`, then the global value as the fallback it always was. A value the config can only express once must not be injected into a map that is keyed per model. |
| proxenos sends only the 7-day quota window, so the app shows a "weekly limit" banner | Quota reporting must mirror the shape Anthropic returns. |
| After a reboot the router listened 4 minutes after login (26s of it between exec and `listen()`), and for that whole window Claude Desktop was a blank page with `ERR_PROXY_CONNECTION_FAILED` — in picker mode every byte the app sends goes through us, so a router that is merely slow reads as an app that is broken (2026-09-14 09:59 boot → 10:15:59 listening) | The launchd agent is `ProcessType=Interactive`, never `Background` (that key throttles CPU and I/O — launchd.plist(5)). `listen()` comes before certificate minting and any other startup work, so a client waits rather than being refused. Every startup logs its budget (`startup Nms: node …, config …, listen …`). |
| "Start Router" ran `launchctl kickstart -k`, which kills a router that is already coming up and starts the wait over (three runs in the four minutes after login, 2026-09-14) | Starting is idempotent: a running agent is left alone, an unloaded one is re-bootstrapped. Only `restart` may force. |
| With the router down, the tray app's window loaded the router-served GUI and showed the same blank page as Claude Desktop — nothing anywhere said why | The cause is always named where the user asked for the dashboard. Since the window was dropped (2026-09-16) the tray opens the dashboard in the browser: with the router down it starts it first, and if it does not come up a dialog explains why Claude Desktop is blank. The app keeps a login item so it is there before Claude Desktop is, and posts a notification when the router has been down for 20s. |
| Windows: the scheduled task inherited the console that started it, so closing the installer window killed the router with `0xC000013A` (Ctrl+C), 2026-09-14 | The task runs a PowerShell launcher that uses `Start-Process -PassThru -Wait`: detached from any console, still tracked so `RestartCount` keeps acting as KeepAlive and the exit code (including the health self-exit 75) propagates. |
| Windows: `install` registered a logon-triggered task and stopped there, so the router did not exist until the next sign-in — launchd starts at bootstrap (`RunAtLoad`) and the difference was invisible | `install` starts the supervisor itself on both platforms and prints the result. |
| Windows: trusting the CA failed with "this operation cannot use the UI" — every PowerShell call carried `-NonInteractive`, and the confirmation dialog never appeared, so picker mode stopped with no certificate and no explanation | Certificate trust and removal run WITHOUT `-NonInteractive` (and without `windowsHide`). They are UI operations by design: the OS must be able to show the user what it is being asked to trust. |
| Windows: sign-in failed with `missing_required_parameter` because the OAuth URL was opened via `cmd /c start`, and cmd reads `&` as a command separator — everything after the first parameter was cut off and run as commands (2026-09-14) | Browsers are opened with `Start-Process <url>` as a single quoted argument. Any URL we hand to a shell must survive its metacharacters. |
| The provider form's "also show in the Claude app picker" box only records `cli.extraModels`; picker mode itself stayed off, nothing was injected, and the user believed the picker was on (Windows x64, 2026-09-14: `config.json` had no `picker` key, no CA, no Config Library) | When that box is ticked while picker mode is off, the form says so under the box and offers to turn picker mode on right after saving. Any control that *looks* like it enables picker mode must either enable it or say what is still missing. |
| A DeepSeek mapping answered `401` on every real request while the provider form's own "Test connection" stayed green — the test sends the provider's headers alone, live traffic also carried the caller's `authorization` (2026-09-15, Windows) | A routed request carries provider authentication only (§4). The connection test and live traffic must present the same auth set, or the test certifies a path nobody uses. |
| Mapping Haiku 4.5 did nothing: the app sends `claude-haiku-4-5-20251001` while the GUI only offers the undated `claude-haiku-4-5`, and route lookup was an exact key match, so the request passed through and Haiku answered itself (2026-09-15) | Route lookup accepts both the dated and undated form of a model id. A mapping the GUI offers must be one the router can actually match. |
| The native `anthropic` provider (ingress-only) was offered as a mapping target and could be given picker entries; a slot pointed at it made every Claude request fail with `400` (2026-09-15) | Ingress-only providers never appear as mapping targets and create no picker/direct rules. A rule that names one is ignored at resolve time, so an existing config degrades to passthrough instead of failing. |
| Windows: "Connect Claude subscription" always failed with "Claude Code CLI not found" — discovery looked for an extensionless `claude` on PATH and for the macOS Application Support cache, neither of which exists there (2026-09-15) | Launcher discovery is per-platform: `.exe`/`.cmd`/`.bat` names on Windows, both AppData roots for the Desktop-cached CLI, and a shell for the `.cmd` launcher that cannot be spawned directly. |
| After updating to 0.1.1 the same Windows install still answered `401` on DeepSeek: the files were new, the router process was the one the scheduled task had started from the old files, and `start` leaves a running router alone. The router also reported `0.1.0` (a literal in two places), so nothing could tell (2026-09-15) | An update replaces the process, not only the files: the app compares the running router's version and files (`/api/status.runtime`) with its own once per launch, re-runs `install` when this installation is not the recorded one, and restarts. One `VERSION` constant, tested against the manifests. |
| Windows: `restart` on a packaged install never restarted anything — the router runs as `ClaudeRipple.exe` (Electron as Node) and the pid lookup only matched `node.exe`, so no shutdown was sent and `Start-ScheduledTask` was ignored by the task already running; the command still reported "restarted" (found 2026-09-16, review of the update path) | Process discovery matches every runtime we launch, and a restart that finds no process to stop must say so instead of claiming success. The installer's own stop script already matched `ClaudeRipple.exe`; two lookups for the same process must not diverge. |
| The DeepSeek `401` stayed unexplained for a day: a provider error was logged as a status code only (2026-09-15) | Upstream 4xx/5xx bodies are logged (first 300 characters, key-shaped strings masked) and kept in the request record. This is the same rule already required of the translator above. |
| "Connect Claude subscription" from the tray/GUI failed with "setup-token failed": `claude setup-token` is an interactive terminal flow and neither place has a terminal (2026-09-15, Windows) | Without a TTY the error says to run `clauderipple claude-login` in a terminal and that an existing Claude Code login is reused anyway; other failures carry what `claude` printed. A button that cannot work where it is must say where it works. |
| Closing Claude Desktop's window does not quit it; reopening hits `Not main instance, returning early` and the app silently keeps the OLD proxy setting. The user sees "I configured it and nothing happened" with no error anywhere (2026-09-14) | Tell the user that closing the window is not enough, and detect it: with picker mode on, the router knows whether the app is actually routing through it. Surface "configured, but the app has not restarted yet" rather than letting it fail silently. |
| A subagent prompt carried `[[ripple: deepseek@high]]` while `aliases` had no `deepseek`; the marker resolved to a model id nobody declared, `resolve()` returned null, and the request went to Anthropic as an ordinary `PASS` — 30 × `404 model: deepseek-v4.1-flash` over two days, read by the session as "the model stopped working" (2026-09-19/20) | A non-`claude-*` model this router cannot route is **refused here, by name**: `400 invalid_request_error "ClaudeRipple: <reason>"`, tag `REFUSE`, reason in the request record (`unroutableReason`: undeclared / declared by two providers / ingress-only owner / unknown marker alias / alias to an undeclared model). Native `claude-*` ids keep passing through untouched — Claude traffic is never hijacked to say no. And the marker alias table is derived from the agent files themselves (§4), so an agent that exists is an alias that resolves. |
| A rejected Claude account remained quarantined after its access/refresh token was replaced, because runtime health used the durable account id; keying affinity on that same generation id would instead move a healthy conversation after every refresh (found during multi-account implementation, 2026-09-20) | Runtime health keys on `<local-owner>:<token-generation-digest>`, while conversation affinity and admin state key on the durable local owner. A refresh or re-login receives fresh health without losing its prompt-cache claim; compare-and-swap prevents an old rejection from marking the new generation. |
| The worker registry was four places that did not know each other — `providers.*.models`, `aliases`, `~/.claude/agents/*.md`, and prose in CLAUDE.md — and every new provider needed all four edited by hand; the one left out was the one that failed (2026-09-19, DeepSeek) | One source: a ticked model *is* a worker. Agent files and marker aliases are generated from `config.json` (§4 "worker definitions"); nothing about a worker is written twice. |
| ChatGPT prompt-cache hit fell from 93% (2026-09-13) to 9% (2026-09-20) with nothing in our request changing — the backend had started keying the cache on the conversation's identity (`session-id`/`thread-id`/`x-client-request-id`/`client_metadata`), which we never sent; `prompt_cache_key` alone no longer earned a write | The adapter states the conversation's identity the way the Codex CLI does (§4) and echoes `x-codex-turn-state`. The acceptance metric (≥90% on translated providers) is watched per day in `requests.jsonl`; a fall with an unchanged request means the wire changed under us, and the reference to diff against is the real CLI captured through a local proxy, not our own memory of the protocol. |
| Remote Control registration failed locally with 405 before Anthropic saw it: Claude Code 2.1.275 uses HTTPS absolute-form (`POST https://api.anthropic.com/v1/environments/bridge HTTP/1.1`) rather than CONNECT for registration, polling and heartbeats, while the forward-proxy socket accepted CONNECT only (issue #10, Windows 11) | Accept valid HTTPS absolute-form, strip proxy-only headers, replace Host, rewrite only the target to origin-form, and relay one request over direct TLS outside model routing. Force `Connection: close`: reusing that TLS socket could send a later proxy-form request to the first origin. Parser tests plus a live local TLS origin verify body and credential preservation. |
| Re-running `clauderipple install` as a normal Windows user rewrote the launcher, then `Register-ScheduledTask -Force` could answer `0x80070005 Access is denied` even though the existing per-user task was already correct (issue #9) | Reuse an existing task only when its entire intended definition matches: one PowerShell action and exact arguments, current user, limited interactive logon, one matching logon trigger, restart count/interval, no execution limit, IgnoreNew, and battery policy. A missing, stale or foreign same-named task still takes the normal registration/error path. |
| OpenCode Go's relay answered `403 {"message":"Error from provider (Console Go): Upstream request failed: …"}` during a few seconds of its own trouble. The 403 was classified as an auth failure, which both cooled the credential for 60s **and** removed it from the retry candidate list, so the router could not retry inside the turn and answered the user with what read as an authentication error. Five times in a day, each cleared by asking again (2026-09-21) | A 403 whose body reports an upstream failure is charged a **zero** cooldown. It is not a statement about the credential, and any wait at all moves the conversation off a key that did nothing and takes its prompt cache with it (§4). With no cooldown the credential stays retryable, so the turn is answered on the next attempt instead of becoming a user-visible failure. The body is the only way to tell this apart from a real 403 (policy, region, blocked model), so it is read for 403 and only 403. |
| The same relay 403 kept reaching the user after that fix, because it was the wrong layer: DeepSeek runs on `openai-compatible`, whose adapter was **never** retried at all — the in-turn retry lives only in the anthropic-compatible wire path (`nextCredential`), and `credentialsOf` gives a translated provider exactly one credential and no fallback. So a relay hiccup had nowhere to go but the user (2026-09-21, root cause of the day's repeated "authentication failed") | Every translated adapter retries the `fetch` **before** any status or byte is written, so the turn is still replaceable (§4 "the first byte commits the turn"). `fetchWithRetry` retries only `transient` verdicts — connect failures, 5xx, and a 403 reporting a broken upstream — to the ceiling of 10 attempts the CLI itself uses, with a 250ms→2s backoff. A 401/429 is **not** retried: the adapter holds one credential, so asking the key that just refused the identical request again only delays the error. `classify` is reused for the judgement, with `kind === "transient"` narrowing a pool's answer to an adapter's. |
| Workers on muse-spark-1.3 "stalled for minutes, then died": 84 of 1,815 turns (2026-09-18..22) waited a median 58s — five exactly 300s — and then the upstream closed the stream with **no** `response.completed`, no usage, no text. Both translated adapters finished such a stream as `end_turn` with whatever had arrived (the ChatGPT one by a comment saying so), so Claude Code received an empty, successful turn, did not retry, and the subagent ended with nothing. Same shape on `chatgpt` (gpt-6-astra, 12 turns, median 105s) and DeepSeek. A non-streaming failure was likewise answered 200 with the fragment | A turn is finished only when the vendor says so: `response.completed`/`response.incomplete` on Responses, a `finish_reason` or `[DONE]` on Chat. A stream that closes without one, or breaks mid-read, ends in an SSE `overloaded_error` — the one mid-stream error Claude Code retries on its own (CLI 2.1.278 matches `"type":"overloaded_error"` in the message; `api_error` is final). Non-streaming turns answer 529 with the same error, and the request record says the turn failed. The upstream stall itself is the vendor's; what must not happen here is turning it into an answer. |
| A session switched from gpt-6-astra to claude-opus-5-5 failed every turn with `400 messages.2.content.0.thinking: each thinking block must contain thinking`: the translated adapters hand the CLI reasoning as `thinking` blocks with no signature (and no text when the reasoning item had no summary), the CLI keeps them, and passthrough replayed them to Anthropic (2026-09-28) | Before a request reaches Anthropic (`PASS` and the account-pool provider), assistant `thinking` blocks without a signature are dropped (`thinking.ts`) — Anthropic's own always carry one — and a turn left empty goes with them. Passthrough stays byte-exact when there is nothing to drop. |
| Re-running the installer — the documented update — replaced the files and left the router running the old code: `install` treats a running router as done, and on Windows and Linux an unchanged supervisor definition is not re-registered, so nothing restarted it until the next login (found 2026-09-28 while building `update`; the tray's own restart covered only the packaged app) | `install` asks a router that is already running for its version and restarts one that differs. Measured in the Windows 11 VM: 0.5.1 running, installer run with 0.6.0 → "restarting it on 0.6.0", status 0.6.0. |
| The tray's Electron (~270MB) was fetched into the installed package's own `node_modules`, and `npm install -g` of any other version deleted it with the old files (measured 2026-09-28): every update silently took the tray away, and on Windows a running tray held `electron.exe` inside the folder npm had to replace | Electron lives in `<home>/tray-runtime`, outside anything an update replaces. Both install scripts move one found in the old place there before installing (Windows first stops a tray running from it, and starts it again after setup) — checked on macOS and in the VM with a locked `electron.exe`. |
| Adding a provider in the settings window restored three OpenCode effort ladders realigned by hand five hours earlier, so the app's effort menus for DeepSeek and GLM never narrowed (2026-10-02 23:13, found 10-05). `PUT /api/config` takes the whole config, and the screen built it from the copy it loaded at open and never re-read; the router itself also writes `config.json` (a measurement's results), so any of those was undone by the next unrelated save | Every GUI save fetches the router's config first and applies its own change to that. A provider form, which holds per-model fields (wire, ladder, window) from when it opened and has no control for them, takes a saved model's values from the router's copy. The provider and client screens re-read the config whenever they load. |

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


### Codex context-overflow recovery

The subscription backend can reject an oversized request with HTTP 200 followed by
`response.failed` / `context_length_exceeded`. The Messages adapter maps this to
`invalid_request_error` and prefixes `prompt is too long`, which Desktop CLI
2.1.284 recognizes. Keep the initial message-start event pending until another
translated event arrives so an early rejection can retain HTTP 400. Transient
overloads and interrupted streams remain retryable.

Both streaming and non-streaming early-rejection paths are covered by adapter
tests. The client still needs to compact its history or otherwise reduce input;
this mapping does not increase the backend's context limit.
