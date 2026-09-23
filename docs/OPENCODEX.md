# opencodex — behavioural notes and the gap list

What this file is for: opencodex solves most of the problem ClaudeRipple solves, and it has been
at it longer. Its documentation describes how each provider is actually spoken to, which is the
expensive knowledge — not the code. This file keeps that knowledge so nobody re-reads 43 documents
to add one adapter, and keeps an honest list of what we do not have yet.

**Read the code when the documentation runs out.** It usually does: the docs say a sidecar exists,
not what it sends. Reading is how you learn what a thing actually does, and refusing to look is how
you end up writing a preset from a model card and being wrong four times in a row.

**Copying is still out.** opencodex is MIT, so copying would be legal with its notice retained, and
the project rule (CLAUDE.md) is still no: the moat is the 1P integration, not the adapter count, and
a borrowed structure built for a different runtime and a different client would be rewritten anyway.
So: read it, understand it, write our own. Facts, wire formats and endpoint names are not anybody's
property; their prose and their code are.

---

## 1. Why the two projects are not the same shape

opencodex is built around **Codex**, and around clients that let you point them at a base URL. That
assumption is what lets it carry 79 provider presets and 14 client integrations: every one of them
is a config file it writes.

ClaudeRipple exists because **Claude Desktop's Code tab does not offer that setting** in 1P mode —
the gateway switch is a whole-app deployment mode that costs connectors, Remote Control and side
sessions (§2 of ARCHITECTURE). So we terminate TLS and intercept, which reaches a surface a
base-URL product cannot, and costs us a CA, a picker injection and a bootstrap rewrite.

**The goal is to be a superset**: everything opencodex does, plus 1P. A router is singular — a user
cannot run both — so a subset is not a choice anyone can make.

**How opencodex reaches Claude Desktop — settled 2026-09-23.** Since v2.61.0 (2026-09-22, PR #5319
merged 2026-09-20) `ocx claude desktop apply` defaults to a **first-party** mode: it writes
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` into `~/.claude/settings.json` and terminates TLS for
`api.anthropic.com` only (`/v1/messages`, `/v1/messages/count_tokens`), so the app keeps claude.ai,
connectors and Remote Control (`src/claude/desktop-first-party.ts`). The gateway (3P) profile is an
explicit `--gateway` opt-in. What it does **not** do: touch the claude.ai bootstrap, so the Code-tab
picker shows only Claude names and a routed model is reached through `modelMap` (a Claude name
answering as GPT) — their own docs say model discovery is unavailable in that mode. Native Claude and
routed models in one picker is their open issue #1213. 1P alone is no longer our distinction; the
picker (models by their real names, effort passed through) is.

Claude Code 2.1.272 also contains Anthropic's own `claude gateway`: an enterprise auth, telemetry and
spend gateway with a model-to-upstream table. The measured provider families are Anthropic, Vertex,
Bedrock and Foundry and its catalog is Claude-only, so it chooses **how to buy Claude**, not which
vendor's model answers. The plumbing narrows the technical moat, but not the product distinction:
ClaudeRipple is the multi-vendor route that keeps the 1P app.

## 2. The gap, in the order it matters

Judge by "could someone using opencodex switch to us without losing something they use", not by
counting config keys. They have roughly 300; most are per-vendor workarounds accreted over time.

### Tier 1 — a switch is impossible without these

| Gap | What it is | Why it blocks |
|---|---|---|
| ~~Account and key pools~~ **closed** | Several accounts or API keys per provider, rotation, cooldown on `Retry-After`/quota reset, quarantine on reauth, session affinity | Key pools and Claude accounts shipped in 0.3.0; ChatGPT accounts, including Codex's own GPT traffic through the ingress, on 2026-09-24 (ARCHITECTURE §4, §4b). Not taken: their priority tiers, per-account auto-switch thresholds and round-robin/reset-first strategies — ours is fill-first in list order with pause |
| Failover routing | One virtual model id over several targets | Same problem, other half: without it a dead provider is a dead session |
| More adapters | `google` (AI Studio / Vertex / Antigravity), `azure-openai`, `ollama-native` | Presets cannot substitute: these speak wires our four adapters do not |
| Vision sidecar | Describe an image with a vision-capable model, hand the text to a text-only model | An image sent to a text-only routed model breaks the turn today |
| Web-search backends | Ours does OpenAI-compatible web plugins and Anthropic-shaped server tools. Theirs adds `xai`, `gemini` and `exa` | A user on none of those loses search |
| Usage and cost | Append-only usage ledger, list-price cost estimates | We record tokens per request and stop there |

### Tier 2 — real draws, not blockers

Routing profiles (score candidates on latency, health, cost, quota headroom; hard requirements;
dry-run). Client exports (opencode, Pi, Cursor, Raycast and others — each is a config file).
Image and video bridges. Model picker ordering and visibility. Storage and log cleanup.

### Tier 3 — deliberately not now

Remote hub and remote workspace (an executor on another machine, sandboxed exec, E2E-encrypted
sessions). Codex SQLite log guard. The exotic adapters: `kiro`, `cursor`, `devin`, `codebuddy`,
`qoder`.

## 3. Adapter wire notes

The part that costs time to discover. Each of these is a specification to implement against, not a
design to copy.

- **`openai-chat`** — Chat Completions family. `reasoning_effort` is clamped to what the model
  advertises. Codex's system prompt names GPT-5 explicitly, so it needs rewriting to be
  model-agnostic before a non-OpenAI model sees it.
- **`openai-responses`** — Responses. Canonical OpenAI forwarding relays only an allowlist of
  headers rather than passing everything through.
- **`anthropic`** — `/v1/messages`, credential as `x-api-key` or as a bearer depending on vendor.
  Extended thinking takes a computed token budget rather than a level (roughly 1024 at the low end
  to 32000 at the top). OAuth against a Claude subscription is supported.
- **`google`** — three modes behind one adapter: AI Studio, Vertex, and Antigravity's Cloud Code
  Assist. Gemini returns a `thoughtSignature` that must be preserved and cached across turns, or
  reasoning continuity breaks. Inline image results come back as artifacts and need a retention
  policy (they cap per-image and per-response sizes and prune).
- **`azure-openai`** — Responses with an `api-key` header; otherwise the OpenAI shape.
- **`ollama-native`** — Ollama's own `/api/chat` (NDJSON, not SSE), with `/api/show` consulted for
  model metadata. Structured output is refused rather than faked.
- **`kiro`** — Amazon CodeWhisperer streaming, `application/vnd.amazon.eventstream` framing.
- **`cursor`** — HTTP/2 Connect with protobuf; a turn-shaped call rather than a stream of deltas.
- **`devin`** — Connect streaming with hand-rolled protobuf framing.

Cross-cutting behaviours worth stealing as behaviour:

- **Keep-alive.** An SSE comment every couple of seconds while upstream is silent, so a slow model
  does not read as a dead connection. We have no equivalent and should.
- **Stall deadline.** A single timeout (theirs defaults to 300s) that ends a silent stream as an
  explicit incomplete response rather than hanging.
- **MCP tool names.** Flatten `namespace__name` on the way out and restore on the way back — the
  same problem our own tool-name mangling solves (§4 of ARCHITECTURE), reached independently.
- **413 before the stream starts** is translated into a context-length error the client understands,
  rather than surfacing as a transport failure.

## 4. Design patterns worth reusing

**Account pool.** Accounts carry a priority, a strategy (quota-first, round-robin, fill-first), an
auto-switch threshold as a percentage of quota consumed, and a sticky limit so a conversation does
not hop mid-thread. A bound thread stays on its account for cache affinity — switching accounts
means a cold prompt cache, which is worth saying out loud in the UI. Failures are classified:
a rejected credential quarantines the account, a rate limit cools it down until its reset.

**Combos.** A virtual model id pointing at an ordered list of targets, with a strategy. The detail
that matters: once output has started, the target is committed — a failover may only happen before
the first byte reaches the client. Otherwise a half-written answer gets replaced mid-stream.

**Sidecars.** The shape is: strip the hosted tool the provider cannot run, offer the model a plain
function tool in its place, run a small loop, and hand the result back in the shape the client
parses. Backends are explicit and **fail closed** — a missing credential means no sidecar rather
than a silent fallback to somebody else's quota. Our web-search interception is the same shape,
arrived at from the other direction (§4 of ARCHITECTURE).

Read closer (2026-09-18), the web-search sidecar is specifically:

- The hosted `web_search` is replaced by a synthetic function tool `web_search(query)`, and the
  routed model calls that instead. Passthrough routes are left alone so the provider runs its own.
- Backends are `openai` (ChatGPT forward, the default), `anthropic` (Anthropic OAuth), `xai`,
  `gemini` and `exa`. **No Brave, Tavily or SearXNG** — every backend is either somebody's hosted
  search or the Exa API.
- The search budget is `maxSearchesPerTurn`, default **3**. When it runs out the synthetic tool is
  removed and the model is forced to answer from what it already has, rather than looping.
- Results come back as ordinary function `tool_result` text, capped (answer 4000 chars, 8 sources),
  and the outbound translation turns them into `server_tool_use` + `web_search_tool_result` for
  Claude Code.
- A backend named without its credential yields **no sidecar at all**; it never borrows another
  backend's login.

**The loop is the part we do not need.** It exists because their backends cannot be handed an
Anthropic server tool directly. Where a provider runs `web_search_20250305` itself — DeepSeek's own
endpoint does — the side request needs no translation and no loop: what comes back is already the
shape the CLI parses. That is `anthropicServerToolBackend`, and it is roughly forty lines because
the hard part was knowing which providers qualify, which is a measurement and not a design.

**OpenClaude is not a comparable.** It is a terminal coding agent, not a proxy; its search is a
client-side adapter with fourteen backends (Firecrawl, Tavily, Exa, Brave, SearXNG, DuckDuckGo by
default …) chosen by `WEB_SEARCH_PROVIDER`, falling through the list when a credential is missing.
Worth remembering only for the one idea we lack: **a default backend that needs no credential at
all.** Everything we and opencodex offer assumes the user is already paying somebody. A live check
on 2026-09-20 found that DuckDuckGo's Instant Answer API is not general web search and its HTML
endpoint serves a bot challenge to unattended calls, so that idea is not a backend we can ship by
copying the label. Bing RSS answers without a key but its terms are not a safe default for a public
product. This gap remains open rather than being filled with an unreliable scraper.

**Fail closed, and say what was removed.** Their drops are logged by name and surfaced. This is the
rule we learned the hard way with server tools: a capability that disappears silently is worse than
one that fails loudly.

## 4a. OpenCode Go, measured (2026-09-18)

Added as three presets, because one subscription reaches its models through three endpoints and a
provider carries one url, one wire and one auth header. Everything here came from the endpoint
rather than the documentation, which does not say most of it — and where it was guessed from
convention first, the guess was wrong four times in a row.

| | `/responses` | `/chat/completions` | `/messages` |
|---|---|---|---|
| wire | OpenAI Responses | OpenAI Chat | Anthropic Messages |
| auth header | `Authorization: Bearer` | `Authorization: Bearer` | **`x-api-key`** |
| base url | `…/zen/go/v1` | `…/zen/go/v1` | **`…/zen/go`** |

- **Each endpoint follows the auth convention of the API it imitates**, and each ignores the other's
  header. Established without a real key: the header a server does not recognise answers "Missing
  API key", the one it does answers "Invalid API key". Sending both would satisfy all three.
- **The base url differs by provider kind, not by vendor.** An openai-compatible provider has the
  endpoint name appended, so its base carries the `/v1`; an anthropic-compatible one has the
  caller's whole `/v1/messages` appended, so the same base asks for `/v1/v1/messages` — answered
  with the website, as an HTML 404.
- **`x-opencode-session` gates the request, not just the cache.** Without it: 400 `MissingSessionID`,
  "cannot be routed efficiently". Filled with `conversationKey`, the prompt cache reached
  **2545/2640 = 96%** on a repeated turn.
- **`GET /models` needs no key** and returns the real ids.
- **Muse Spark's effort ladder is `none … xhigh`.** `max` and `ultra` are refused with
  `invalid_request_error`, which no model card says.
- **The Contributor models are refused until the workspace opts in**: 403 `DataPolicyError`, with
  the link. Meta states those interactions are used to improve its products, which is the whole
  reason the tier is ~90% cheaper.
- Muse Spark reasons on every turn: "Reply with exactly: MUSE OK" cost 302 output tokens, and a
  64-token ceiling returned an empty answer because the reasoning consumed all of it.

## 5. Where we are ahead

- **1P preservation.** The TLS-terminating proxy and bootstrap injection reach the Code tab without
  the gateway switch, so connectors, Remote Control and side sessions survive (§2, §3).
- **Server tools by measured capability.** They always strip a hosted `web_search` and replace it
  with a sidecar. We pass it through where the provider actually runs it — DeepSeek does, which its
  own documentation does not mention (§4). No sidecar, no second bill, better results.
- **Shutdown and health discipline.** Draining SIGTERM, refusing new calls with a retryable 503
  while draining, self-exit on consecutive upstream failures, one log line per request from arrival
  to completion (§5). These were written against observed failures, not anticipated ones.
