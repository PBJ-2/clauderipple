# Architecture review, 2026-10-24

A review of the router and the dashboard on `main` plus #91 (the Auto mode classifier's per-stage targets), written for the refactors that follow it. It looks for **deepening opportunities**: places where a module's interface is nearly as complex as its implementation, or where one rule is written in many places, so that a change or a bug has to be chased across files.

Vocabulary, used exactly: **module** (anything with an interface and an implementation), **interface** (everything a caller must know: types, invariants, error modes, ordering, config), **depth** (behaviour behind a small interface; *deep* is a lot, *shallow* is an interface nearly as complex as the implementation), **seam** (where an interface lives, where behaviour can change without editing in place), **adapter** (a concrete thing satisfying an interface at a seam), **leverage** (what callers get from depth), **locality** (what maintainers get from depth). In the graphs, solid arrows are calls or data, dashed arrows cross a seam, red marks a leak or a defect, and dark nodes are the deep modules.

Line numbers refer to `feat/classifier-stage1-target` at `5caeffd`, the head of #91, where the review was made.

## Verdict

Refactoring is worth doing now, for two reasons. A request's kind does not exist as a value, so it cannot reach the provider adapters; as a result the Auto mode classifier's security prompt is altered on its way to every translated provider, against ARCHITECTURE §2. And several rules about providers are written in up to sixteen places, in two spellings, with the dashboard keeping its own copies. The two `Strong` candidates below are in-process and testable as pure functions. The provider-turn and dashboard-save candidates are larger and need their own plan; the `validate` one is small.

| # | Candidate | Strength | Status |
|---|---|---|---|
| 1 | [A request's kind, decided once](#1-a-requests-kind-decided-once-and-carried-with-its-route) | Strong | in progress |
| 2 | [One provider-turn seam](#2-one-provider-turn-seam-for-the-five-provider-branches) | Worth exploring | |
| 3 | [Provider capabilities in one module](#3-provider-capabilities-answered-in-one-module) | Strong | next |
| 4 | [One config-update module in the dashboard](#4-one-config-update-module-for-the-dashboards-saves) | Worth exploring | |
| 5 | [`validate` takes raw input](#5-validate-merges-defaults-itself) | Worth exploring | |

## 1. A request's kind, decided once and carried with its route

`Strong` · `in-process` · Files: `packages/router/src/routing.ts`, `proxy.ts`, `identity.ts`, `providers/{chatgpt,openai,google,grok}`

**Before**

```mermaid
flowchart TB
  REQ([Messages request]) --> H["proxy.ts handle()"]
  H -->|"884 purpose check"| REC[(requests.jsonl)]
  H -->|"889"| WS[web search answer]
  H -->|"899 its own route"| WF[web fetch route]
  H -->|"947"| RES["resolve()"]
  H -->|"954 the same rules again"| UR["unroutableReason()"]
  RES -->|"Resolved: provider, model, tag"| AD{adapter}
  AD --> CG["chatgpt: adds identity line + image hint"]
  AD --> AC["anthropic-compatible: adds identity + addendum"]
  AD --> OG["openai · google · grok: add identity + addendum"]
  RES -.->|"1846 splits the tag string"| FO[failover]
  classDef leak stroke:#c62f2f,stroke-width:2px,color:#c62f2f;
  class UR,CG,AC,OG,FO leak
```

**After**

```mermaid
flowchart TB
  REQ([Messages request]) --> K["requestKind()"]
  K -->|kind| D["decide()"]
  D -->|"route: kind, asked"| AD{adapter}
  D -->|refusal| X[400 refused]
  D -->|"no route"| PASS[passed to Anthropic as is]
  K -->|kind| REC[(requests.jsonl)]
  AD --> PA["promptAdditions(kind)"]
  PA -->|"classifier: nothing added"| CG[chatgpt]
  PA --> AC[anthropic-compatible]
  PA --> OG["openai · google · grok"]
  D -->|asked| FO[failover]
  classDef deep fill:#15243a,stroke:#15243a,color:#e8eef7,stroke-width:3px;
  class K,D,PA deep
```

- **Problem**: whether a request is a classifier stage, a search, a fetch or a continue is worked out on several lines of `proxy.ts`, and the answer never reaches the adapters. So a classifier request routed to ChatGPT gets `You are gpt-6-luna (reasoning effort: high), answering through Claude Code, a terminal-based coding agent.` in front of the security prompt and the image-generation hint after it; the OpenAI-compatible, Google, Grok and Anthropic-compatible paths add the identity line and the addendum.
- **Solution**: `requestKind()` decides the kind once; `decide()` returns the route or the reason there is none, in one pass; every adapter takes what it may add from `promptAdditions(kind)`, which gives a classifier request nothing.
- **Wins**: locality, the kind is decided in one place · the security prompt really is left intact · `unroutableReason`, a second copy of `resolve`'s rules, goes · no more parsing of the log tag · the interface is a pure-function test surface.
- **ARCHITECTURE §2** promises the original security prompt stays intact. This candidate restores that decision; it does not reopen it.

## 2. One provider-turn seam for the five provider branches

`Worth exploring` · `ports & adapters` · Files: `proxy.ts` (~1034–1321), `providers/{openai,chatgpt,google,grok}`, `routing.ts` (`threadDecision`)

**Before**

```mermaid
flowchart TB
  P["proxy.ts handle()"] --> B1[ChatGPT branch]
  P --> B2[OpenAI-compatible branch]
  P --> B3[Google branch]
  P --> B4[Grok branch]
  P --> B5[Claude pool branch]
  B1 -->|"thread · refusal · effort · tag · 502"| U1[(ChatGPT)]
  B2 -->|"the same five + drives the pool itself"| U2[(OpenAI-compatible)]
  B3 -->|"the same five + recordOutcome"| U3[(Google)]
  B4 -->|"refusal record fields missing, no health record"| U4[(Grok)]
  B5 -->|"thread · effort · tag · 502"| U5[(Anthropic)]
  classDef leak stroke:#c62f2f,stroke-width:2px,color:#c62f2f;
  class B4 leak
```

**After**

```mermaid
flowchart TB
  P["proxy.ts handle()"] --> T["provider turn"]
  T -.->|seam| A1[ChatGPT adapter]
  T -.->|seam| A2[OpenAI-compatible adapter]
  T -.->|seam| A3[Google adapter]
  T -.->|seam| A4[Grok adapter]
  T -.->|seam| A5[Claude pool adapter]
  A1 --> O[one outcome type]
  A2 --> O
  A3 --> O
  A4 --> O
  A5 --> O
  O --> T
  classDef deep fill:#15243a,stroke:#15243a,color:#e8eef7,stroke-width:3px;
  class T deep
```

- **Problem**: `proxy.ts` repeats thread policy, the refusal response, recording the effort, the log tag, the 502 path and health bookkeeping by hand for each provider, and the branches have already drifted (Grok's thread refusal lacks `refusal` and `upstreamCalled`; Grok never calls `providerHealth.observe`).
- **Solution**: one seam, "send this Messages turn to this target", with one outcome type; the five providers become adapters that translate and send.
- **Wins**: five adapters justify the seam · nowhere left for branches to drift · locality for credentials and health · turn-level tests without a TLS rig.
- **ARCHITECTURE §5**: most of the recorded failure modes (vanished requests, cache hit rate) live in these branches. Move one branch at a time.

## 3. Provider capabilities, answered in one module

`Strong` · `in-process` · Files: `routing.ts`, `proxy.ts`, `agents.ts`, `config.ts`, `model-scores.ts`, `admin.ts`, `packages/ui/app.js`

**Before**

```mermaid
flowchart LR
  subgraph R [router]
    RT["routing.ts ×2"]
    PX["proxy.ts ×5"]
    AG["agents.ts ×2"]
    CF["config.ts validate ×2"]
    MS[model-scores.ts]
    AM["admin.ts"]
  end
  subgraph UI ["dashboard app.js"]
    G1[groupedModels]
    G2[classifierGroups]
    G3[fallbackEffortLevels]
    G4[web search row]
  end
  RT --> Q1{{"routable target? spelling A"}}
  CF --> Q1
  AG --> Q1
  MS --> Q1
  G1 --> Q1
  G2 --> Q1
  PX --> Q2{{"routable target? spelling B"}}
  AM --> Q2
  G3 -.->|copy| EL["admin.ts effortLevels"]
  PX -->|"imported from the HTTP module"| EL
  G4 -.->|copy| SR["proxy canRunServerTools"]
  classDef leak stroke:#c62f2f,stroke-width:2px,color:#c62f2f;
  class Q1,Q2,G3,G4 leak
```

**After**

```mermaid
flowchart LR
  RT[routing.ts] --> CAP
  PX[proxy.ts] --> CAP
  AG[agents.ts] --> CAP
  CF[validate] --> CAP
  MS[model-scores.ts] --> CAP
  CAP["provider capabilities: routable · owners · effortLevels · canAnswer"]
  CAP --> API["/api/status · /api/effort-levels"]
  API -.->|seam| UI["app.js draws the answers"]
  classDef deep fill:#15243a,stroke:#15243a,color:#e8eef7,stroke-width:3px;
  class CAP deep
```

- **Problem**: "an `anthropic` provider without `accountPool` is not a routing target" is written in sixteen places in two spellings (`accountPool` alone, or with `auth === "claude-code"`), and `validate` refuses it for fallbacks and classifier targets but lets a primary route or a direct rule through, which `resolve` then drops silently. Model ownership, effort levels and whether a target can answer a web search are also computed separately by the router and the dashboard, and their answers differ.
- **Solution**: a provider-capabilities module in the router answers "can this provider be a target, and why not", "who owns this model id", "which efforts does it take" and "can it answer this kind of request"; the dashboard receives the answers through `/api/status` and only draws them.
- **Wins**: one rule, sixteen call sites · the dashboard stops copying router rules · one place for `validate`'s refuse-or-allow policy · effort levels leave the HTTP module.
- **ARCHITECTURE**: the fallback entry already records that adding fallbacks "re-opened the §5 row about ingress-only targets". With one home for the rule it would not have reopened.

## 4. One config-update module for the dashboard's saves

`Worth exploring` · `in-process` · Files: `packages/ui/app.js` (`configRequest`, `latestConfig`, fourteen save functions), `packages/router/test/ui-*.test.ts`

**Before**

```mermaid
flowchart TB
  S1[model mapping save] --> L1["latestConfig() → clone → change"]
  S2[classifier save] --> L2["latestConfig() → clone → change"]
  S3[OpenAI-compatible form save] --> L3["latestConfig() → clone → change"]
  S4["… eleven more"] --> L4[the same steps each]
  L1 --> CR["configRequest()"]
  L2 --> CR
  L3 --> CR
  L4 --> CR
  CR --> PUT[(PUT /api/config)]
  S1 -->|"resets three flags"| F[views reload]
  S2 -->|"redraws its own box"| F
  S3 -->|"forgets clientsLoaded"| F
  classDef leak stroke:#c62f2f,stroke-width:2px,color:#c62f2f;
  class S3 leak
```

**After**

```mermaid
flowchart TB
  S1[model mapping save] -->|mutator| U
  S2[classifier save] -->|mutator| U
  S3[OpenAI-compatible form save] -->|mutator| U
  U["updateConfig(mutator)"] --> PUT[(PUT /api/config)]
  U -.->|"changed config"| V1[slots]
  U -.-> V2[providers]
  U -.-> V3[clients]
  classDef deep fill:#15243a,stroke:#15243a,color:#e8eef7,stroke-width:3px;
  class U deep
```

- **Problem**: fourteen save sites rewrite read-modify-write themselves; "start from `latestConfig` or the 409 rebase cannot run" is written nowhere; the OpenAI-compatible form does not reset `clientsLoaded`, so the Clients page keeps old model lists after such an edit.
- **Solution**: `updateConfig(mutator)` owns reading the latest config, the rebase, committing and telling views what changed; each view subscribes.
- **Wins**: locality for the save rules · no forgotten reloads · UI tests through an interface instead of source text.
- **Note**: `app.js` is one classic script with no modules, so splitting it comes first.

## 5. `validate` merges defaults itself

`Worth exploring` · `in-process` · Files: `packages/router/src/config.ts` (`validate`, `merge`, `DEFAULTS`), `admin.ts` (PUT `/api/config`, three background writers)

**Before**

```mermaid
flowchart LR
  CS[ConfigStore] -->|"merged with defaults"| V["validate(c: Config)"]
  PUT["PUT /api/config"] -->|"raw JSON"| V
  BG["background writers ×3"] -->|"raw JSON"| V
  V -->|"no routes"| ERR[TypeError]
  V --> OK["errors[]"]
  classDef leak stroke:#c62f2f,stroke-width:2px,color:#c62f2f;
  class PUT,BG,ERR leak
```

**After**

```mermaid
flowchart LR
  CS[ConfigStore] --> V
  PUT["PUT /api/config"] --> V
  BG["background writers ×3"] --> V
  V["validate(input: unknown)"] --> OK["errors[]"]
  classDef deep fill:#15243a,stroke:#15243a,color:#e8eef7,stroke-width:3px;
  class V deep
```

- **Problem**: `validate` assumes a config already merged with `DEFAULTS`, but PUT `/api/config` and three background writers pass the JSON they received. A config without `routes` throws `TypeError: Cannot convert undefined or null to object` instead of returning an error list (checked by calling it).
- **Solution**: `validate` takes `unknown`, merges defaults, then checks shape and rules behind one interface.
- **Wins**: one rule fewer for callers · a partial config gets an error list · tests stop spreading `...DEFAULTS`.

## Top recommendation

[**1. A request's kind, decided once**](#1-a-requests-kind-decided-once-and-carried-with-its-route). It fixes a defect against a recorded decision right next to the code #91 touched, and gathers the cost every new request kind used to pay (several lines of `proxy.ts` plus every adapter) into one module. Its dependencies are in-process, so it is tested as pure functions without a TLS rig.

## Fine as is

These look like candidates at first sight but should be left alone.

- `resolve`'s rule order, `isAutoModeClassifier` and `isClassifierStage1`: already deep, with fast tests.
- The in-turn credential retry and the 403/402/429 read-ahead (`proxy.ts` ~1386–1579): intricate but one piece; splitting it piecemeal would break it.
- `dropForeignThinking`, `websearch.ts`, `hold.ts` and `tether.ts`, `classifierRowsOf` and `classifierSettingOf`.
