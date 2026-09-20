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
  `model:` = the exact id, `@medium` when the provider offers that level). It
  records what it wrote in `<home>/generated-agents.json` and touches **only**
  those files: a hand-written agent of the same name wins and is left alone, an
  unticked model removes its generated file and nothing else, identical content is
  not rewritten. `cli.agentFiles: false` turns generation off. The marker alias
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
  expires after 5 minutes. The grant (access + refresh token, expiry) is stored
  only in `<home>/claude-auth.json` (mode `0600`) as `source: "oauth"`; the
  ingress refreshes it up to 5 minutes before expiry (one refresh shared by
  concurrent requests) and a failed refresh becomes a clear 401 rather than a
  dead token. The GUI drives the same flow through `POST/GET /api/claude-oauth`
  and `POST /api/claude-oauth/code`; no token value ever appears in an admin
  response or a log line. `--setup-token` keeps the previous path (`claude
  setup-token` from a terminal, long-lived token, `source: "setup-token"`).
  `claude-logout` removes the file either way. Wire facts are behaviorally
  measured (the reference implementations do the same flow); they are not an
  Anthropic guarantee, and reuse of a subscription is subject to its terms.
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
| Tool names over 64 characters were forwarded to the Responses API unchanged, so a single connected MCP server — the product's own use case (§2) — failed every request of that turn (found by reading the source, issue #1, 2026-09-17) | Any name a translated provider sends is mangled into the provider's constraint deterministically and restored on the way back (§4). A translator must validate what it forwards against the wire it forwards to, not only what it builds itself. |
| Unknown-model context window defaulted to 200K, compaction fired at 151K; fixed via `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000` (applies only to models not in the CLI's built-in table; Claude models unaffected) | Installer sets this env for mapped models; document that it does not affect Claude models. |
| Server tools (`web_search`) were declared to translated providers as ordinary functions: a tool the model can call and nothing can run. Not observed live, because Claude Code currently routes its web search elsewhere (§4) — the failure was one server-side flag away, and its shape is an empty answer with nothing logged (issue #4, 2026-09-17) | A translator declares only what the provider can actually execute, and says in the log what it removed. A capability that silently disappears is worse than one that visibly fails. |
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
| The worker registry was four places that did not know each other — `providers.*.models`, `aliases`, `~/.claude/agents/*.md`, and prose in CLAUDE.md — and every new provider needed all four edited by hand; the one left out was the one that failed (2026-09-19, DeepSeek) | One source: a ticked model *is* a worker. Agent files and marker aliases are generated from `config.json` (§4 "worker definitions"); nothing about a worker is written twice. |

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
