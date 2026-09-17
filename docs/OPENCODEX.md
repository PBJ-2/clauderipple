# opencodex — behavioural notes and the gap list

What this file is for: opencodex solves most of the problem ClaudeRipple solves, and it has been
at it longer. Its documentation describes how each provider is actually spoken to, which is the
expensive knowledge — not the code. This file keeps that knowledge so nobody re-reads 43 documents
to add one adapter, and keeps an honest list of what we do not have yet.

**No code has been read or copied, and none may be.** opencodex is MIT, so copying would be legal
with its notice retained, and the project rule is still no: the moat is the 1P integration, not the
adapter count, and a borrowed structure built for a different runtime and a different client would
be rewritten anyway. Everything below came from its published documentation (2026-09-17,
`docs-site/src/content/docs/`), restated rather than quoted. Facts, wire formats and endpoint names
are not anybody's property; their prose is.

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

One thing the documentation does not settle: **how opencodex reaches Claude Desktop.** It has
`ocx claude desktop apply/export/import`, per-family profiles and hashed model aliases
(`claude-opus-4-8-<hash>`), but not whether 1P features survive. If it uses the gateway setting they
are lost, and this is our moat. Worth establishing before assuming either way.

## 2. The gap, in the order it matters

Judge by "could someone using opencodex switch to us without losing something they use", not by
counting config keys. They have roughly 300; most are per-vendor workarounds accreted over time.

### Tier 1 — a switch is impossible without these

| Gap | What it is | Why it blocks |
|---|---|---|
| Account and key pools | Several accounts or API keys per provider, rotation, cooldown on `Retry-After`/quota reset, quarantine on reauth, session affinity | The main reason people run it. We hold one credential per provider, so an exhausted quota stops the work |
| Failover routing | One virtual model id over several targets | Same problem, other half: without it a dead provider is a dead session |
| More adapters | `google` (AI Studio / Vertex / Antigravity), `azure-openai`, `ollama-native` | Presets cannot substitute: these speak wires our four adapters do not |
| Vision sidecar | Describe an image with a vision-capable model, hand the text to a text-only model | An image sent to a text-only routed model breaks the turn today |
| Web-search backends | Ours does OpenAI-compatible web plugins only | A user whose provider is not one of those loses search |
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

**Fail closed, and say what was removed.** Their drops are logged by name and surfaced. This is the
rule we learned the hard way with server tools: a capability that disappears silently is worse than
one that fails loudly.

## 5. Where we are ahead

- **1P preservation.** The TLS-terminating proxy and bootstrap injection reach the Code tab without
  the gateway switch, so connectors, Remote Control and side sessions survive (§2, §3).
- **Server tools by measured capability.** They always strip a hosted `web_search` and replace it
  with a sidecar. We pass it through where the provider actually runs it — DeepSeek does, which its
  own documentation does not mention (§4). No sidecar, no second bill, better results.
- **Shutdown and health discipline.** Draining SIGTERM, refusing new calls with a retryable 503
  while draining, self-exit on consecutive upstream failures, one log line per request from arrival
  to completion (§5). These were written against observed failures, not anticipated ones.
