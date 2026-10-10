# Ripple mod — design (2026-10-10)

The status mod in `packages/mod` grows into ClaudeRipple's in-session control surface: it picks
the reasoning effort for every prompt, picks the worker for every delegated task, can keep the
prompt cache warm, and carries the session tools a heavy Claude Code user needs (context, cache,
limits, compact/handoff). The open-source mod "effortless" (HeyCubit, MIT) proved most of the
main-chat ideas; it is a **behavioral reference only** — no code is copied from it, as with the
other reference implementations (project CLAUDE.md).

## Measured before design (2026-10-10, Claude Code 2.1.293 from the desktop app bundle, `-p`)

| Question | Result |
|---|---|
| A mod registers an agent type and swaps it at spawn | `$.agent.register({name:'auto',…})` → `ripplespike:auto`; `agent.spawn` rewriting `subagentType` to `deepseek-v4-1-flash` and `model` to `deepseek-v4.1-flash@low` ran the worker on that id. |
| `$.model.complete` with a router model id | `deepseek-v4.1-flash` answered in 1.9 s through the router; `claude-haiku-5-5` in 0.96 s. |
| `$.model.fork` reads the session's cache | fork of a 46k-token chat: `cache_read_input_tokens` 46,301, cache write 60, output 4. The fork fires `turn.step` with no `agentId` (looks like a main request). |
| `turn.step` effort rewrite keeps the cache (Sonnet 5.5) | three resumed turns at medium → low → high: cache read 46.9k / 47.0k / 47.0k, writes 66–97; the router recorded effort low/high. |

The terminal CLI on this Mac is 2.1.278, below the 2.1.287 mods minimum; the desktop app runs
2.1.293. API facts not measured here come from the official mods docs
(code.claude.com/docs/en/plugins/mods/*) and the generated declarations in
`packages/mod/.claude-plugin/types/claude-code/index.d.ts` (written by 2.1.293), which win over
prose when they disagree.

## Identity

- Plugin name becomes `ripple` (agent type `ripple:auto`, command `/ripple`). `packages/cli/src/settings.ts`
  recognises both `ripple` and the old `clauderipple-status` when it adds or removes the plugin dir.
- `/ripple-log` and `/ripple-bar` stay as aliases.
- The "not affiliated with Anthropic" notice appears in the settings panel footer.

## Engine rules every file must follow

- `$` may be used only inside `hooks/register.tsx` (the engine follows `$` only into functions of
  the file that holds the hooks, and refuses passing `$` to imported helpers). Everything else is
  pure: plain functions, data in, data out, unit-tested with `node --test`.
- No Node APIs in mod code. Imports: relative files and `claude-code` only.
- Module variables die on reload; `$.state` atoms survive reload but not `/clear`; `$.store` is shared by
  every session on the machine (4 MiB). Settings live in the store; per-chat things in atoms.
- `$` calls after a hook returns are refused: background work runs from `$.clock.every` timers
  started in `session.start`.
- Hooks budget 10 s of own time; a failing hook before `next` fails open. Every hook wraps its own
  work so a bug never blocks a prompt, a spawn or a request.

## 1. Effort Auto (main chat)

- **When:** `prompt.submit` from a person (origin composer/bridge/sdk). Skipped for host slash
  commands, for short follow-ups (≤ 12 chars and ≤ 2 words, no attachment, previous assistant tail
  has no `?`) which keep the current pick, and while Auto is off.
- **Judge input:** model family + current effort, last user message (400 chars), last assistant
  tail (2,000 chars), next message (2,000; Jev 4,000), attachment counts, context %. Mid-turn
  submissions are marked as steering of the running work.
- **Judges:** `haiku` (default; `$.model.complete` `claude-haiku-5-5`, effort low, 160 tokens, 6 s,
  one retry on alias `haiku`), `jev` (TypeSafe, §4; falls back to Haiku on failure, > 3 s, or
  confidence < 0.5), `model` (any router model id via `$.model.complete`, e.g. `deepseek-v4.1-flash`;
  falls back to Haiku). Output `{effort, sure, why}`; `why` ≤ 6 words in the user's language.
- **Verdict → effort:** bias −2..2 tips only close calls (|bias| 1: sure < 0.65; 2: sure < 0.85) by
  one step; then floor/ceiling (ceiling below floor = floor); then Save mode caps at medium.
  A lower effort chosen mid-turn waits for the turn to end.
- **Apply:** `turn.step`, main requests only (`agentId` undefined, not our own fork), rewriting
  `effort` for every request of the prompt. Only on cache-safe models: ids matching
  `(opus|sonnet|haiku)-5-5`. Everything else (Fable, older, non-Claude main models) shows
  `Paused` — unmeasured there, and Fable 5.1 lost 56–100 % of its cache per effortless.
- **Person wins:** the first effort seen on a main request is the app's; a later differing app
  effort means the person changed it → Auto off, toast, pass through. Manual effort buttons set a
  manual pick and fill `/effort <level>` in an empty prompt so the app's own control follows.

## 2. Worker Auto (subagents) — new

- `session.start` registers `ripple:auto`: description tells the main model to delegate any task
  through it and that the mod picks the model and effort (this replaces the worker table people
  keep in CLAUDE.md). Its prompt is the generated workers' shared executor prompt.
- `agent.spawn` with `subagentType` `ripple:auto` (or, with setting `agentAuto: all`, also
  `general-purpose` without an explicit `model`): judge the task, then rewrite `subagentType` and
  `model`. Explicit choices are respected: a named worker or an explicit `[[ripple: x@y]]` marker
  skips the judge (the existing `worker.ts` fixes still apply).
- **Tiers, not names.** The judge picks a tier and an effort; settings map tiers to agents:
  - `light` — chores, repetitive, simple lookups → default `deepseek-v4-1-flash`
  - `standard` — designed implementation, research, review → default `gpt-6-1-sol`
  - `deep` — careful, high-stakes, hard reasoning → default `gpt-6-astra`
  - `design` — UI, visual, brand → default Claude `sonnet` (`general-purpose` + `model: sonnet`)
  Defaults are only used when that agent exists (generated-agents.json); otherwise the tier falls
  back to the next tier up that exists, finally `general-purpose` + `sonnet`.
- **Availability:** before choosing, read the router's `/api/status`. A ChatGPT-backed worker
  (agent file description `… via chatgpt`) is unavailable when no ChatGPT account is `ready` with
  every rate-limit window under 100 %; then the tier's `fallback` (default `general-purpose` +
  `sonnet`) runs and the spawn's toast says why.
- **Effort:** router workers get `@<effort>` on the model id (the router's own suffix); Claude
  agents get it through `turn.step` for that `agentId` (spawn result carries it).
- Judge input: description, prompt (first 3,000 chars), tier criteria. Same judges as §1 (Jev with
  a `tier` question instead of `model`). Output `{tier, effort, sure, why}`. Judge failure →
  `standard` at `high`.
- The pick (tier, agent, effort, why, judge, ms) is recorded for the Agents pane and stats.

### 2a. Two worker modes (decided 2026-10-10, after the tier design above)

- **Manual (`workerMode: 'tiers'`)** — the tier table above, plus:
  - per-provider on/off: a switched-off provider's workers are never picked, by any path;
  - a preference order of providers/models: within a tier the first usable one runs, and quota
    exhaustion moves down the order;
  - per-tier effort calibration: an offset (−2..+2 steps on the judge's effort) and floor/ceiling,
    since one effort word means different work on different models.
- **Auto (`workerMode: 'auto'`)** — data picks the model and effort:
  - the judge answers only the intelligence the task needs (a level mapped to an Artificial
    Analysis Intelligence Index floor, e.g. chores ≥ 30, designed implementation ≥ 45, hard ≥ 50,
    hardest ≥ 53);
  - candidates are every (enabled worker × effort) that AA measured; pick the cheapest by AA's
    **cost per task in USD** (it folds input, cache and output prices — money, not tokens, is the
    measure) among those at or above the floor; the preference order breaks near-ties (within a
    few index points);
  - providers out of quota or switched off drop out; design work keeps its manual target (AA
    does not measure taste).
- **Data:** a daily GitHub Action (`.github/workflows/aa-data.yml`, secret `AA_API_KEY`) reads the
  AA API (index, prices per variant) and each tracked variant's model page (its embedded record's
  `intelligenceIndexCostPerTask.cost.total`; the free API has no cost per task), and force-pushes
  one `aa-models.json` to the orphan branch `data`. Routers fetch that file at most daily and
  serve `/api/model-scores`; users need no AA key. Attribution "Data: Artificial Analysis" shows
  wherever the numbers do. Measured 2026-10-10: GPT-6.1 Sol high — index 50.2, $0.319/task; GPT-6
  Astra medium — 49.6 with 5× Sol's output price.

## 3. Keep warm — new, off by default

- Toggle on the band and in settings; `keepWarmHours` 1/2/4/8 (default 2) bounds how long after the
  last real reply it keeps going; `keepWarmMinTokens` (default 30k) skips small chats.
- Timer every 15 s: when the main chat is idle, its cache is warm, context ≥ min tokens, the
  cache would expire within 4 min (1 h TTL) or 60 s (5 min TTL), and the bound is not reached →
  `$.model.fork({prompt: 'Reply with just: ok'})`. Success with `cache_read_input_tokens > 0`
  restarts the countdown; null / no cache read → stop and say so once.
- A fork's own `turn.step` is not user activity: a module flag set around the fork keeps it out of
  effort Auto, busy state and stats (its usage counts as keep-warm cost instead).
- Each ping costs one cache read of the whole chat (~10 % of its input price, and the same share
  of a subscription's limits); the band shows pings and their total.

## 4. Jev (TypeSafe)

- `POST https://api.typesafe.ai/v1/systemone`, `authorization: Bearer <key>`, body
  `{model:'jev-latest', state:{task, current_model, current_effort, recent_conversation, next_message},
  questions:{<name>:{type:'choice', instructions, criteria:{<option>:<text>}}}}`; answers at
  `answers` or `result.answers`, each `{choice, confidence?, probabilities?}`; `usage.input_tokens`
  + `output_tokens`. 401/403 key rejected, 402 out of credits, 429 rate limited.
- Key: `TYPESAFE_API_KEY` env, else `~/.config/jev/.env` (`TYPESAFE_API_KEY=`), else the key pasted
  in settings, which is written to that file (mode 600). Sent to TypeSafe only. Prompts sent to
  Jev leave the machine — the settings card says so.

## 5. Session tools

- **Cache countdown:** TTL from the last main response's `usage.cache_creation` (1 h vs 5 m; default
  1 h), expiry = last main response + TTL; restored after reload from an atom; resumed chats use
  `classic.SessionStart.seconds_since_last_response` / `prompt_cache_likely_expired`.
- **Context:** `$.session.usage().context` (percent, tokens, window); unknown shows nothing.
- **Limits:** `rateLimits` `five_hour` / `seven_day` (max shown); ≥ 80 % shows the hot band with
  Save mode (caps Auto at medium until the window resets).
- **Bands** (priority): settings → compact note → handoff choice → setup → judge down → hot →
  result cards → cold (cache expired on a ≥ 150k chat) → swamp (context ≥ `swampAt`, default 50 %)
  → dashboard. Each alert dismisses until it worsens.
- **Compact with Haiku:** `session.compact` for the main chat (not subagents, not `precompute`,
  which is skipped): serialize the transcript (last 6 messages' tool I/O 20k chars, older inputs
  400 / results 2k; 2.4M char budget, then tighter, then engine fallback), Haiku 5.5, 16k tokens,
  240 s; success needs > 200 chars; failure falls back to the engine's own compaction with a toast.
  Setting `compactWith: haiku | session`.
- **Handoff:** Quick (fork writes a resumable summary; fallback: ordinary turn) or Full (configured
  skill, else an ordinary turn that checks git and writes `HANDOFF.md`); then continue (clear +
  resume), confirm (clear + state + wait) or copy. Haiku advice from 30 % context, every second
  real prompt, turns Compact into a lit Handoff when a fresh chat clearly pays.
- **Stats** (`/ripple stats`): Auto-steered prompts by effort, weighted cost (input 1, write 1.25,
  read 0.1, output 5), judge counts/time/tokens, worker picks by tier, keep-warm pings and cost.

## 6. Interface

- **Band (desktop, SVG-drawn):** effort (Deciding glow / Paused / Off) · model · context ring ·
  cache countdown (with a keep-warm mark) · limits · last route (provider colour, cache hit) ·
  Auto · Warm · Compact/Handoff · Log · Agents · ⚙. Terminal: the same in text with hotkeys.
  Minimal layout: footer controls only.
- **Panes:** Log (existing request log) and Agents (each subagent: tier/agent/effort/why, state,
  current tool, elapsed, cost).
- **Settings panel** (cards): Effort · Workers (tier → agent selects, fallback, agentAuto) · Judge
  (Haiku / Jev with key + Test / router model) · Cache (keep warm, hours, min tokens) · Compact &
  Handoff · Look (dashboard/minimal, appearance auto/dark/light).
- **First run:** a short setup (judge, worker tiers, keep warm) opens once.
- Colours: ClaudeRipple accent `#6a56d6` (from packages/ui), provider hues from the existing
  `providerColor`; status green/amber/red stay semantic.

## Left out on purpose

- Per-prompt cheaper-model routing of the main chat: each model has its own cache, so a move in a
  warm chat costs ~5–10× staying (effortless measured; it ships off by default too).
- effortless's self-update card and uninstall: the mod ships inside ClaudeRipple, which updates it.
- Terminal pixel art and sounds (inactive in effortless as well). Revisit after the rest lands.

## Tests

- Pure modules: `packages/mod/test/*.test.ts`, run by `npm test` (`node --test`).
- Hooks and drawings: `packages/mod/tests/*.test.ts(x)` with `claude-code/testing`, run by
  `claude plugin test packages/mod` on ≥ 2.1.293.
- Live: desktop Code tab session with the mod loaded — band, a delegated task through
  `ripple:auto`, keep-warm ping visible in the router log.
